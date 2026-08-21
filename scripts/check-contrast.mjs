const checks = [
  ['الرابط الأساسي على الأبيض', '#087566', '#ffffff'],
  ['الرابط الأساسي على الخلفية', '#087566', '#faf9f6'],
  ['النص الثانوي على الأبيض', '#526171', '#ffffff'],
  ['النص الثانوي على الخلفية', '#526171', '#faf9f6'],
  ['الرابط الداكن', '#6ee7d0', '#0c2136'],
  ['النص الثانوي الداكن', '#c5d1dc', '#0c2136'],
  ['نص التذييل', '#d5e3ee', '#06182d'],
  ['زر أبيض على تركوازي', '#ffffff', '#087566'],
  ['نص شريط المقالات الفاتح', '#26384e', '#f8fafc'],
  ['شارة أحدث المقالات الفاتحة', '#ffffff', '#0a2342'],
  ['نص شريط المقالات الداكن', '#e7eef5', '#0a1e32'],
  ['شارة أحدث المقالات الداكنة', '#06182d', '#9be7d9']
];
const lightCategories = ['#6d28d9', '#087566', '#1d4ed8', '#965708', '#0a2342'];
const darkCategories = ['#c4b5fd', '#6ee7d0', '#93c5fd', '#f9c76b', '#a7c7e7'];

function rgb(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

function luminance(hex) {
  const [red, green, blue] = rgb(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function mix(foreground, background, amount = 0.12) {
  const mixed = rgb(foreground).map((value, index) => value * amount + rgb(background)[index] * (1 - amount));
  return `#${mixed.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
}

lightCategories.forEach((color, index) => checks.push([`القسم الفاتح ${index + 1}`, color, mix(color, '#ffffff')]));
darkCategories.forEach((color, index) => checks.push([`القسم الداكن ${index + 1}`, color, mix(color, '#0c2136')]));
const failures = checks.map(([label, foreground, background]) => ({ label, ratio: contrast(foreground, background) })).filter(({ ratio }) => ratio < 4.5);
if (failures.length) {
  failures.forEach(({ label, ratio }) => console.error(`${label}: ${ratio.toFixed(2)}:1`));
  process.exit(1);
}
console.log(`Contrast audit passed ${checks.length} light/dark text combinations at WCAG AA (>= 4.5:1).`);
