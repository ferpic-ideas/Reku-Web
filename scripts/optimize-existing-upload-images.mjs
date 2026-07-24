import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { pool, query } from "../src/db.mjs";
import { uploadRoot } from "../src/config.mjs";
import { optimizeImageBuffer } from "../src/uploads.mjs";

const jobs = [
  {
    table: "services",
    idColumn: "id",
    pathColumn: "image_path",
    folder: "services",
    options: { width: 1200, height: 720, fit: "cover" },
  },
  {
    table: "professionals",
    idColumn: "id",
    pathColumn: "photo_path",
    folder: "professionals",
    options: { width: 512, height: 512, fit: "cover" },
  },
];

const isAlreadyOptimized = (metadata, options) =>
  metadata.format === "webp" &&
  Number(metadata.width || 0) <= options.width &&
  Number(metadata.height || 0) <= options.height;

const saveOptimized = async (folder, buffer) => {
  const relativePath = `${folder}/${randomUUID()}.webp`;
  const absolutePath = join(uploadRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer, { mode: 0o640 });
  return relativePath;
};

const optimizeJob = async (job) => {
  const result = await query(
    `
      SELECT ${job.idColumn} AS id, ${job.pathColumn} AS path
      FROM ${job.table}
      WHERE ${job.pathColumn} IS NOT NULL
        AND ${job.pathColumn} <> ''
        AND deleted_at IS NULL
      ORDER BY ${job.idColumn} ASC
    `,
  );
  const summary = {
    table: job.table,
    checked: result.rows.length,
    optimized: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
  };

  for (const row of result.rows) {
    const currentPath = String(row.path || "");
    const absolutePath = join(uploadRoot, currentPath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) {
      summary.missing += 1;
      continue;
    }

    try {
      const input = await readFile(absolutePath);
      const metadata = await sharp(input).metadata();
      if (isAlreadyOptimized(metadata, job.options)) {
        summary.skipped += 1;
        continue;
      }

      const optimized = await optimizeImageBuffer(input, job.options);
      const nextPath = await saveOptimized(job.folder, optimized);
      await query(`UPDATE ${job.table} SET ${job.pathColumn} = $1, updated_at = NOW() WHERE ${job.idColumn} = $2`, [
        nextPath,
        row.id,
      ]);
      summary.optimized += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
};

try {
  const summaries = [];
  for (const job of jobs) {
    summaries.push(await optimizeJob(job));
  }
  console.log(JSON.stringify({ ok: true, summaries }, null, 2));
} finally {
  await pool?.end();
}
