// A smoke test against the live API. Usage:
//   MEDILOOP_API_KEY=sk_live_... MEDILOOP_FACILITY=<uuid> MEDILOOP_PATIENT=<uhid> node dist-test/test/live.js
import { Client, PermissionError } from '../src/index.js';

const m = new Client({ apiKey: process.env.MEDILOOP_API_KEY ?? '' }).forFacility(process.env.MEDILOOP_FACILITY ?? '');
const cover = await m.post('/api/v1/coverage/verify/', { patient_uhid: process.env.MEDILOOP_PATIENT ?? '', benefit_category: 'consultation', amount: 50000 });
console.log('cover:', JSON.stringify({ covered: cover.covered, insurer: cover.primary?.insurer_name ?? null, patient_pays: cover.patient_responsibility }));
let n = 0;
for await (const _ of m.paginate('/api/v1/healthcare-billing/bills/', { page_size: 10 })) { void _; n++; }
console.log(`bills read across pages: ${n}`);
try {
  await m.get('/api/v1/fraud/flags/');
} catch (e) {
  if (e instanceof PermissionError) console.log(`refusal carried its reason: ${e.errorCode} (HTTP ${e.status})`);
  else throw e;
}
