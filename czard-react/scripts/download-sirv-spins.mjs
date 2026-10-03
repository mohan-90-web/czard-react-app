import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = resolve(projectRoot, 'media-manager/cdn/shop/360')
const spins = [
  { key: 'veni', path: 'Veni-Black-360-Final/Veni-Black-360-Final.spin', infoId: '1279988844' },
  { key: 'vidi', path: 'Vidi-Ivory-360-Final/Vidi-Ivory-360-Final.spin', infoId: '1447315820' },
  { key: 'vici', path: 'Vici-Green-360-Final/Vici-Green-360-Final.spin', infoId: '2994184844' },
  { key: 'ecru', path: 'CreamV2_360/CreamV2_360.spin', infoId: '1236478194' },
  { key: 'lac-leman', path: 'Siwss_Blue_360/Siwss_Blue_360.spin', infoId: '707556236' },
  { key: 'jura-gruen', path: 'Swiss_Green_360/Green_360.spin', infoId: '79879970' },
]

const concurrency = 12
const retries = 3
const jobs = []

for (const spin of spins) {
  const baseUrl = `https://mjrepublic.sirv.com/Spins/${spin.path.slice(0, spin.path.lastIndexOf('/') + 1)}`
  const metadataUrl = `https://mjrepublic.sirv.com/Spins/${spin.path}?info=sirv_spin_info_v1_${spin.infoId}`
  const metadataResponse = await fetch(metadataUrl)
  if (!metadataResponse.ok) throw new Error(`Could not load ${spin.key} manifest: HTTP ${metadataResponse.status}`)

  const metadata = await metadataResponse.json()
  const frameNames = Object.values(metadata.layers['1'])
    .filter((name) => /^0_\d+\.png$/.test(name))
    .sort((left, right) => Number(left.slice(2, -4)) - Number(right.slice(2, -4)))
  if (frameNames.length === 0) throw new Error(`No frames found for ${spin.key}`)

  const outputDirectory = resolve(outputRoot, spin.key)
  await mkdir(outputDirectory, { recursive: true })
  for (const frameName of frameNames) {
    jobs.push({ spin, baseUrl, frameName, outputDirectory })
  }
  spin.frameCount = frameNames.length
  console.log(`${spin.key}: ${frameNames.length} frames`)
}

let nextJob = 0
let finished = 0
let failed = 0

async function downloadWorker() {
  while (nextJob < jobs.length) {
    const job = jobs[nextJob]
    nextJob += 1
    const outputPath = resolve(job.outputDirectory, job.frameName)
    try {
      if ((await stat(outputPath).catch(() => null))?.size > 0) {
        finished += 1
        continue
      }

      const frameUrl = `${job.baseUrl}${job.frameName}?scale.option=fill&w=600&h=0`
      let response
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        response = await fetch(frameUrl)
        if (response.ok) break
        if (attempt === retries) throw new Error(`HTTP ${response.status}: ${frameUrl}`)
      }
      await writeFile(outputPath, new Uint8Array(await response.arrayBuffer()))
      finished += 1
      if (finished % 100 === 0 || finished === jobs.length) {
        console.log(`Downloaded ${finished}/${jobs.length} frames`)
      }
    } catch (error) {
      failed += 1
      console.error(`${job.spin.key}/${job.frameName}: ${error.message}`)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, downloadWorker))
await writeFile(resolve(outputRoot, 'spins.json'), JSON.stringify(spins, null, 2))
console.log(`Finished with ${failed} failed frames; metadata written to spins.json`)
if (failed > 0) process.exitCode = 1