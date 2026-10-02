// Renders media/src/*.svg to PNG (the Marketplace requires a PNG icon).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';

const jobs = [
  { src: 'media/src/icon.svg', out: 'media/icon.png', width: 256 },
];
for (const job of jobs) {
  const png = new Resvg(readFileSync(job.src), { fitTo: { mode: 'width', value: job.width } }).render().asPng();
  writeFileSync(job.out, png);
  console.log(`${job.out} (${png.length} bytes)`);
}
