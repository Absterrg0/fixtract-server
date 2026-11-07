import mongoose from 'mongoose';
import LoyaltyConfig from '../../models/loyaltyConfig';

/** Explicit id/revision required even for the default, read-only preview. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--dry-run') continue;
    if (!['--id', '--version'].includes(arg) || !args[index + 1] || values.has(arg)) {
      throw new Error('Usage: --id <confirmed config ObjectId> --version <confirmed version> [--apply]');
    }
    values.set(arg, args[++index]);
  }
  const id = values.get('--id');
  const rawVersion = values.get('--version') || '';
  const version = Number(rawVersion);
  if (!id || !mongoose.Types.ObjectId.isValid(id) || !/^\d+$/.test(rawVersion)
    || !Number.isSafeInteger(version) || version < 1 || (apply && args.includes('--dry-run'))) {
    throw new Error('A confirmed configuration --id and positive integer --version are required; choose --apply or --dry-run.');
  }
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI is required');
  try {
    await mongoose.connect(uri);
    const eligible = await LoyaltyConfig.backfillConfirmedLegacyConfig(id, version, apply);
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} ${id} version ${version}: ${eligible
      ? (apply ? 'repair applied' : 'repair would proceed') : 'repair skipped (revision or completion guard)'}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch(() => {
  console.error('Legacy loyalty repair failed; verify the confirmed id/version and configuration.');
  process.exitCode = 1;
});
