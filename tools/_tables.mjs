import fs from 'node:fs';
const sc = await import('file:///D:/Personal/Documents/deepseek-harness/default-workspace/st-rbq/core/schema.js');
for (const t of sc.getTables()) {
  console.log('  [' + String(t.no).padStart(2) + '] ' + String(t.name).padEnd(18) + (t.group ?? '').padEnd(10) + t.columns.slice(0, 8).join('/'));
}
