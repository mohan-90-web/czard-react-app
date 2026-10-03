(() => {
  const frameName = (index) => `0_${String(index).padStart(4, '0')}.png`
  const wrap = (index, count) => ((index % count) + count) % count

  document.querySelectorAll('.local-spin').forEach((viewer) => {
    const image = viewer.querySelector('img')
    const folder = viewer.dataset.spinFolder
    const frameCount = Number(viewer.dataset.frameCount)
    if (!image || !folder || !frameCount) return

    let frame = 0
    let dragStartX = 0
    let frameStart = 0
    let activePointer = null

    const setFrame = (index) => {
      frame = wrap(index, frameCount)
      image.src = `/www.czard.com/cdn/shop/360/${folder}/${frameName(frame)}`
    }

    viewer.jumpCols = (index) => setFrame(index)
    setFrame(0)

    viewer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      activePointer = event.pointerId
      dragStartX = event.clientX
      frameStart = frame
      viewer.setPointerCapture(event.pointerId)
    })

    viewer.addEventListener('pointermove', (event) => {
      if (event.pointerId !== activePointer) return
      const frameOffset = Math.round((dragStartX - event.clientX) / 2)
      setFrame(frameStart + frameOffset)
    })

    const finishDrag = (event) => {
      if (event.pointerId !== activePointer) return
      activePointer = null
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId)
    }

    viewer.addEventListener('pointerup', finishDrag)
    viewer.addEventListener('pointercancel', finishDrag)
    viewer.addEventListener('contextmenu', (event) => event.preventDefault())
  })
})()
