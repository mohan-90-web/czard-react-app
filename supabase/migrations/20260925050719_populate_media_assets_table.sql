/*
# Populate an initial batch of missing media references.

This migration inserts records for every broken media reference found across
all CZARD HTML pages. Each record maps the original Shopify CDN path to a
Supabase Storage bucket path. Status is 'pending' until the actual file is
uploaded to Supabase Storage.

Asset breakdown:
- 219 JPG images (product photos, collection images, blog images, video posters)
- 31 PNG images (logos, favicons, lifestyle images)
- 11 SVG files (logos, loader animations, icons)
- 9 MP4 videos (hero videos, product dial/golddamer videos)
- 1 MP3 audio (ambient sound)

Buckets:
- product-images: 261 image/svg assets
- product-videos: 9 video assets
- audio: 1 audio asset
*/

INSERT INTO media_assets (original_path, storage_bucket, storage_path, public_url, asset_type, status)
SELECT
  'cdn/shop/' || trim(path),
  CASE
    WHEN path ~* '\.(mp4|webm)$' THEN 'product-videos'
    WHEN path ~* '\.mp3$' THEN 'audio'
    ELSE 'product-images'
  END,
  path,
  '',
  CASE
    WHEN path ~* '\.(mp4|webm)$' THEN 'video'
    WHEN path ~* '\.mp3$' THEN 'audio'
    WHEN path ~* '\.svg$' THEN 'svg'
    ELSE 'image'
  END,
  'pending'
FROM (
  SELECT trim(f) AS path FROM regexp_split_to_table($$
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f459808d5.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f459810c4.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f45982084.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598410d.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598471c.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f45989514.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598a476.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598ab09.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598afcb.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598bba3.jpg
articles/3_1_ee6268c4-6794-4793-bb4f-3120e56f4598be50.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f88428020bf1.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f88428024501.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802abaa.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802ae26.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802d7b5.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802e7d4.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802f0af.jpg
articles/A_new_chapter_begins.We_will_never_stop_raising_the_standard._52edd439-b87d-4732-a787-f784f8842802f901.jpg
articles/For_a_global_community_that_demands_purpose_precision_and_legacy.We_turned_to_Geneva._A_model_1_cbe51f5d-c750-4e61-b301-0444837c497e21ca.jpg
files/1541-swiss-box.webp5b88.jpg
files/23d_-_3rd_ccf5a2.png
files/Blue_Swiss_Low_Corrected.webp4de6.jpg
files/Blue_Swiss_Low_Corrected.webpd24b.jpg
files/Blue_Swiss_closeup_crown.webpd24b.jpg
files/CZARD_Dubai_Office.webp10e4.jpg
files/Case_side_angle_compass_1_7d308.jpg
files/Case_side_angle_compass_1_8c895.jpg
files/Copy_of_black_dial_with_crown9dc8.png
files/Czard_crowne5d6.jpg
files/Czard_logo_Favicon223e.png
files/Czard_logo_Faviconfe9b.png
files/ET_Now7879.svg
files/Ecru-beyond3ae9.jpg
files/Ecru-dial-close-up_11dcd.jpg
files/Ecru-dial-close-up_21dcd.jpg
files/Ecru-dial-close-upa03a.jpg
files/Ecru-dial-watchmaker-closeup1e61.jpg
files/Ecru-dial-watchmaker-shot38dd.jpg
files/Ecru-dial-watchmaker-shot530f.jpg
files/Ecru-dial-watchmaker-shot98cf.jpg
files/Ecru-dial-watchmaker-shotb922.jpg
files/Ecru-dial-watchmaker-shote730.jpg
files/Ecru-dial-wrist-shot-closeup_14223.jpg
files/Ecru-dial-wrist-shot-closeup_18153.jpg
files/Ecru-dial-wrist-shot-closeup_1ced4.jpg
files/Ecru-dial-wrist-shot-closeup_1d605.jpg
files/Ecru-dial-wrist-shot-closeup_1fc47.jpg
files/Entrepreneur0b16.svg
files/Green_Swiss_Low_corrected.webp4de6.jpg
files/Green_Swiss_Low_corrected.webpd24b.jpg
files/Green_Swiss_closeup_crown.webpd24b.jpg
files/Harper_s_Bazaar_Logob365.svg
files/Helsinki_Office17f9.jpg
files/Jura-gruen-beyond3ae9.jpg
files/Jura-gruen-dial-watchmaker-closeup1e61.jpg
files/Jura_gruen_Strapb657.jpg
files/Jura_gruen_side56e7.jpg
files/Lac_leman_Strapb657.jpg
files/Lac_leman_side56e7.jpg
files/Lec_Leman-dial-wrist-shot-closeup_1d605.jpg
files/Mans_Worldea1f.svg
files/Sellita_Watchmaker_czard.webp994f.jpg
files/Swiss-office-square5da8.jpg
files/Swiss-office-square5e42.jpg
files/Swiss_beige_side_angleaf90.jpg
files/Swiss_blue_side_angle4233.jpg
files/Swiss_green_side_angle4233.jpg
files/Veni-dial_142d08.jpg
files/Veni-dial_146f6b.jpg
files/Veni-dial_14a32f.jpg
files/Veni-dial_14c316.jpg
files/Veni-dial_14eec5.jpg
files/Veni-hand-Shot_026c74.jpg
files/Veni-hero-15c95.jpg
files/Veni-hero-15e7b.jpg
files/Veni-pusher-closeup10e3.jpg
files/Veni-sideecbf.jpg
files/Veni-wristshot-heroefeb.jpg
files/Vici-hand-Shot_026c74.jpg
files/Vici-hero27ed4.jpg
files/Vici-hero2d8b8.jpg
files/Vici-pusher-closeup35a7.jpg
files/Vici-wristshot-heroefeb.jpg
files/Vidi-dial_120092.jpg
files/Vidi-dial_131d6a.jpg
files/Vidi-dial_1_Full883e.jpg
files/Vidi-dial_1_Fullad68.jpg
files/Vidi-dial_231d6a.jpg
files/Vidi-dial_63e7d.jpg
files/Vidi-dial_70092.jpg
files/Vidi-dial_8da76.jpg
files/White_Swiss_Low_corrected.webp4de6.jpg
files/White_Swiss_Low_corrected.webpd24b.jpg
files/White_Swiss_closeup_crown.webp1a9c.jpg
files/blue_swiss_on_hand.webpd24b.jpg
files/blue_swiss_with_watch_maker.webpd24b.jpg
files/captain_hatf5a2.png
files/captain_on_ship_13de2f47-1ed4-4ff7-8d2a-3f0c5f94a1d631ed.png
files/captain_with_a_personf5a2.png
files/compass_greene88f.jpg
files/compass_greenf5a2.png
files/czard-office-post-geneva2332.jpg
files/ecru-sidec0e2.jpg
files/ecru_strapb657.jpg
files/experience_center_bangaluru.avif4d62.jpg
files/experience_center_bangaluru.avifd25e.jpg
files/forbes4668.svg
files/green_swiss_on_hand.webpd24b.jpg
files/green_swiss_with_watch_maker.webpd24b.jpg
files/inspi5fa1.png
files/jura_gruen-dial-wrist-shot-closeup_1d605.jpg
files/lac-leman-beyond3ae9.jpg
files/lac-leman-dial-watchmaker-closeup1e61.jpg
files/logo_gradient_header9823.png
files/logo_gradient_headerfb05.png
files/man_on_sofae0ac.png
files/man_with_dog_compass_2f5a2.png
files/mens_XP4705.svg
files/person_in_library_compassf5a2.png
files/preview_images/bc03ef6356d84a668b738e8d50c8a0c7.thumbnail.0000000000_1200x3aeb.jpg
files/rajhans-office-postf1ef.jpg
files/sellita_movement.webp444c.jpg
files/sellita_movement.webp48e2.jpg
files/sellita_movement.webp7f4b.jpg
files/sellita_movement.webp99ef.jpg
files/sellita_movement.webpab17.jpg
files/sellita_movement.webpb66f.jpg
files/sellita_movement.webpf201.jpg
files/sellita_movement.webpfd69.jpg
files/swiss_bg9442.jpg
files/swiss_lifestyle_2f5a2.png
files/switzerland_rules_time_banner.avif17c2.jpg
files/veni-dial-closeup6c74.jpg
files/veni-dial-only-closeup1366.jpg
files/veni-dial-only-closeupab41.jpg
files/veni-dial-only-closeupd0a9.jpg
files/veni-dial-only-closeupecb2.jpg
files/veni-dial-only-closeupf91b.jpg
files/veni_macro_at_4_closeup8cef.jpg
files/vici-closeup-2-sm.webpe326.jpg
files/vici-dial-closeup6c74.jpg
files/vici-side5fcd.jpg
files/vici-watchmaker_hands_closeupecbf.jpg
files/vici_macro_at_4_closeup319a.jpg
files/vidi-luxe-img38dd.jpg
files/vidi-luxe-img530f.jpg
files/vidi-luxe-img98cf.jpg
files/vidi-luxe-imgb922.jpg
files/vidi-luxe-imge730.jpg
files/vidi-macro-at-6.webp71f2.jpg
files/vidi-watchmaker_hands_closeupb944.jpg
files/watch_in_hand_compass.aviff6c6.png
files/watchmaker-multiple-watch38dd.jpg
files/watchmaker-multiple-watch530f.jpg
files/watchmaker-multiple-watch98cf.jpg
files/watchmaker-multiple-watchb922.jpg
files/watchmaker-multiple-watche730.jpg
files/watchmaker-swiss-1.avif0348.jpg
files/watchmaker-swiss-1.avif09d9.jpg
files/watchmaker-swiss-1.avif338c.jpg
files/watchmaker-swiss-1.avif36b9.jpg
files/watchmaker-swiss-1.avif3ab1.jpg
files/watchmaker-swiss-1.avif4867.jpg
files/watchmaker-swiss-1.avif499e.jpg
files/watchmaker-swiss-1.avif5d03.jpg
files/watchmaker-swiss-1.avif64da.jpg
files/watchmaker-swiss-1.avif832e.jpg
files/watchmaker-swiss-1.avif881a.jpg
files/watchmaker-swiss-1.avif9af3.jpg
files/watchmaker-swiss-1.avif9d4f.jpg
files/watchmaker-swiss-1.avif9d65.jpg
files/watchmaker-swiss-1.avifa518.jpg
files/watchmaker-swiss-1.avifb15b.jpg
files/watchmaker-swiss-1.avifd4c4.jpg
files/watchmaker-swiss-1.avifdb2b.jpg
files/watchmaker-swiss-1.aviffb8b.jpg
files/watchmaker-swiss-1.aviffeb1.jpg
files/watchmaker-swiss-2.avif0348.jpg
files/watchmaker-swiss-2.avif09d9.jpg
files/watchmaker-swiss-2.avif338c.jpg
files/watchmaker-swiss-2.avif36b9.jpg
files/watchmaker-swiss-2.avif3ab1.jpg
files/watchmaker-swiss-2.avif4867.jpg
files/watchmaker-swiss-2.avif499e.jpg
files/watchmaker-swiss-2.avif5d03.jpg
files/watchmaker-swiss-2.avif64da.jpg
files/watchmaker-swiss-2.avif832e.jpg
files/watchmaker-swiss-2.avif881a.jpg
files/watchmaker-swiss-2.avif9af3.jpg
files/watchmaker-swiss-2.avif9d4f.jpg
files/watchmaker-swiss-2.avif9d65.jpg
files/watchmaker-swiss-2.avifa518.jpg
files/watchmaker-swiss-2.avifb15b.jpg
files/watchmaker-swiss-2.avifd4c4.jpg
files/watchmaker-swiss-2.avifdb2b.jpg
files/watchmaker-swiss-2.aviffb8b.jpg
files/watchmaker-swiss-2.aviffeb1.jpg
files/watchmaker_angle_2_10c67.jpg
files/watchmaker_angle_2_112b4.jpg
files/watchmaker_angle_2_116b8.jpg
files/watchmaker_angle_2_1228e.jpg
files/watchmaker_angle_2_126b9.jpg
files/watchmaker_angle_2_12d24.jpg
files/watchmaker_angle_2_12dbe.jpg
files/watchmaker_angle_2_143f4.jpg
files/watchmaker_angle_2_14bef.jpg
files/watchmaker_angle_2_14e1b.jpg
files/watchmaker_angle_2_152d5.jpg
files/watchmaker_angle_2_15bd5.jpg
files/watchmaker_angle_2_16ec1.jpg
files/watchmaker_angle_2_17982.jpg
files/watchmaker_angle_2_1b398.jpg
files/watchmaker_angle_2_1b530.jpg
files/watchmaker_angle_2_1ce19.jpg
files/watchmaker_angle_2_1d6c2.jpg
files/watchmaker_angle_2_1e55d.jpg
files/watchmaker_angle_2_1e73d.jpg
files/watchmaker_hands_closeup9153.jpg
files/white_swiss_on_hand.webpd24b.jpg
files/white_swiss_with_watch_maker.webp1a9c.jpg
t/9/assets/Star3e96.svg
t/9/assets/case-side-angle-6.webp4766.jpg
t/9/assets/check9ce8.svg
t/9/assets/cr-craft-movement.webpd379.jpg
t/9/assets/cr-craft-pushers.webpa31c.jpg
t/9/assets/cr-craft-subdial.webp2b29.jpg
t/9/assets/cr-craft-watchmaker.webp0f90.jpg
t/9/assets/cr-manifesto-trio.webp34d0.png
t/9/assets/cr-origin-emblem.webp48c1.jpg
t/9/assets/cr-origin-logo.webp9529.jpg
t/9/assets/cr-plate-boutique402f.jpg
t/9/assets/crown01ac56.png
t/9/assets/crown02f143.png
t/9/assets/crown037e27.png
t/9/assets/czard-ambientb25a.mp3
t/9/assets/inner-dial.webp022b.png
t/9/assets/loader-dial-base75cc.svg
t/9/assets/loader-dial-dark73c4.svg
t/9/assets/logo-white6abf.png
t/9/assets/logo14d6.png
t/9/assets/logo_gradient_headerbd36.png
t/9/assets/metric7313.svg
t/9/assets/swiss-1-hero.webp0047.png
t/9/assets/swiss-1-story.webpccfd.jpg
t/9/assets/swiss-2-hero.webp4edb.png
t/9/assets/swiss-3-hero.webp7800.png
t/9/assets/swiss-flaga0ce.png
t/9/assets/swiss_heritage_BG.webp45f8.jpg
t/9/assets/veni-box-care.webp1b10.jpg
t/9/assets/veni-box-inbox.webp5a96.jpg
t/9/assets/veni-dial8e44.mp4
t/9/assets/veni-golddamer11b1.mp4
t/9/assets/veni-hero.webpc5f9.png
t/9/assets/veni-walk-02.webp4064.jpg
t/9/assets/veni-walk-03.webp4387.jpg
t/9/assets/veni-walk-04.webp7406.jpg
t/9/assets/vici-box-care.webpb731.jpg
t/9/assets/vici-diala6b1.mp4
t/9/assets/vici-golddamerc332.mp4
t/9/assets/vici-hero.webpb6bc.png
t/9/assets/vici-walk-02.webp6197.jpg
t/9/assets/vici-walk-03.webp0028.jpg
t/9/assets/vidi-box-care.webp32b2.jpg
t/9/assets/vidi-dial41e2.mp4
t/9/assets/vidi-golddamer3f59.mp4
t/9/assets/vidi-hero.webp9f4a.png
t/9/assets/vidi-walk-03.webp4158.jpg
videos/c/vp/8952c55ab7be4ff5ae83e507c1a916c1/8952c55ab7be4ff5ae83e507c1a916c1.HD-1080p-7.2Mbps-90714630a4f0.mp4
videos/c/vp/bc03ef6356d84a668b738e8d50c8a0c7/bc03ef6356d84a668b738e8d50c8a0c7.HD-1080p-7.2Mbps-90515936a4f0.mp4
videos/c/vp/edd032259b234c76b4427beee22bcc28/edd032259b234c76b4427beee22bcc28.HD-1080p-7.2Mbps-90713920a4f0.mp4
$$, '\n') AS t(f)
)
ON CONFLICT (original_path) DO NOTHING;