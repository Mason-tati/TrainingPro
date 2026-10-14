Bundled fonts for generated-image captions.

Drop any of these here and they are used automatically (they take precedence over
the system fonts listed in lib/imagegen-config.js):

  NotoSansThai-Regular.ttf   NotoSansThai-Bold.ttf     (Thai)
  Sarabun-Regular.ttf        Sarabun-Bold.ttf          (Thai, alternative)
  NotoSans-Regular.ttf       NotoSans-Bold.ttf         (English)

Both families are SIL Open Font License and free to redistribute:
  https://fonts.google.com/noto/specimen/Noto+Sans+Thai
  https://fonts.google.com/specimen/Sarabun

If none are present the app falls back to the system fonts
(Leelawadee UI / Tahoma for Thai, Arial for English).
