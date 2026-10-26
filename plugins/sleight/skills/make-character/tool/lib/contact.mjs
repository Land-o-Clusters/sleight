// Half-size cells composited in premultiplied alpha, ready to read at the default 96 by 104 pt size.
export function contactSheet(image, theme) {
  const background = { light: [245, 245, 245], dark: [28, 28, 32] }[theme];
  if (!background) throw Error('Unknown contact sheet background');
  const width = image.width / 2, height = image.height / 2;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const out = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const at = ((y * 2 + dy) * image.width + x * 2 + dx) * 4, alpha = image.data[at + 3] / 255;
        sum += image.data[at + channel] * alpha + background[channel] * (1 - alpha);
      }
      data[out + channel] = Math.round(sum / 4);
    }
    data[out + 3] = 255;
  }
  return { width, height, data };
}
