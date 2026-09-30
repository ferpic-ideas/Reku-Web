import { randomUUID } from 'node:crypto';
import { mkdir, copyFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, tx } from '../src/db.mjs';
import { root, publicUploadRoot } from '../src/config.mjs';

// Run only after the deployment backup and migration. No access, pricing or URL changes.
const id = Number(process.argv.find(arg => arg.startsWith('--agreement-id='))?.split('=')[1]);
if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Use --agreement-id=<existing YPF agreement id>');
const apply = process.argv.includes('--apply');
try {
  const result = await tx(async client => {
    const { rows } = await client.query("SELECT id,name,slug,subdomain_prefix,cobranded,brand_theme,logo_path,pdf_path FROM agreements WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id]);
    const before = rows[0];
    if (!before || before.slug !== 'ypf' || before.subdomain_prefix !== 'ypf') throw new Error('Expected the existing ypf / ypf.reku.io agreement');
    if (!apply) return { applied: false, agreement: before, intended_name: 'YPF Obra Social', intended_theme: 'ypf-os' };
    await mkdir(join(publicUploadRoot,'agreements'),{recursive:true});
    const logo = `agreements/${randomUUID()}.png`, pdf = `agreements/${randomUUID()}.pdf`;
    await copyFile(join(root,'agenda/brands/ypf-os/logo.png'),join(publicUploadRoot,logo),constants.COPYFILE_EXCL);
    await copyFile(join(root,'agenda/brands/ypf-os/guia-pacientes.pdf'),join(publicUploadRoot,pdf),constants.COPYFILE_EXCL);
    const { rows: updated } = await client.query("UPDATE agreements SET name='YPF Obra Social', cobranded=TRUE, brand_theme='ypf-os', logo_path=$2, pdf_path=$3, updated_at=NOW() WHERE id=$1 RETURNING id,name,slug,subdomain_prefix,cobranded,brand_theme,logo_path,pdf_path",[id,logo,pdf]);
    await client.query('INSERT INTO audit_events (event_type,detail) VALUES ($1,$2::jsonb)', ['agreement.brand_configured',JSON.stringify({agreement_id:id,before,after:updated[0],source:'configure-ypf-brand'})]);
    return { applied:true,agreement:updated[0] };
  });
  console.log(JSON.stringify(result));
} finally { await pool?.end(); }
