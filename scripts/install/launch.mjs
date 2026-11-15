/** 生成/读取统一的进程启动清单 data/runtime/launch.json。 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function launchFile(installRoot) {
  return path.join(installRoot, 'data', 'runtime', 'launch.json');
}

export async function writeLaunchJson({ installRoot, services }) {
  const file = launchFile(installRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    services: services.filter(Boolean).map((item) => {
      const service = {
        name: item.name,
        command: item.command,
        cwd: item.cwd,
        env: item.env || {},
        health: item.health || null,
      };
      // 运行时解析器是 required 默认值的唯一来源。写入端只保留调用方
      // 明确给出的值，避免 --launch-only 把旧清单的隐含默认写成 true。
      if (item.required === true || item.required === false) {
        service.required = item.required;
      }
      return service;
    }),
  };
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export async function readLaunchJson({ installRoot }) {
  const text = await fs.readFile(launchFile(installRoot), 'utf8');
  return JSON.parse(text);
}
