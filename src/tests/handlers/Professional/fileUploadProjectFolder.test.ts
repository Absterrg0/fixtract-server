import { beforeEach, describe, expect, it, vi } from 'vitest';

// No S3 action: uploadProjectFile is replaced by a stub that builds the same
// key and URL shape the real helper would, without sending anything.
const uploadProjectFile = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/s3Upload')>();
  return { ...actual, uploadProjectFile };
});

import {
  uploadCertification,
  uploadQuestionAttachment,
} from '../../../handlers/Professional/fileUpload';
import { generateFileName } from '../../../utils/s3Upload';
import { projectMediaKeyFor } from '../../../utils/projectMedia';

const OWNER = '64b000000000000000000001';
const VICTIM = '64b000000000000000000002';
const BUCKET = 'https://fixera-uploads.s3.us-east-1.amazonaws.com';

const fakeUpload = async (
  file: { originalname: string },
  userId: string,
  projectId: string,
  fileType: string,
) => {
  const key = generateFileName(file.originalname, userId, `projects/${projectId}/${fileType}`);
  return { url: `${BUCKET}/${key}`, key };
};

const pdf = () =>
  ({ originalname: 'cert.pdf', mimetype: 'application/pdf', size: 1024, buffer: Buffer.from('%PDF-1.4') }) as any;

const mockRes = () => {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

const call = async (handler: (req: any, res: any) => Promise<unknown>, body: Record<string, unknown>) => {
  const res = mockRes();
  await handler({ file: pdf(), user: { _id: OWNER }, body }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  const [, userId, projectId, fileType] = uploadProjectFile.mock.calls.at(-1)!;
  const { url, key } = await uploadProjectFile.mock.results.at(-1)!.value;
  return { userId, projectId, fileType, url, key, data: res.json.mock.calls[0][0].data };
};

const MALFORMED = [
  `x/image/${OWNER}`,
  `x/image/${VICTIM}`,
  '../id-proof',
  'a/b',
  '',
  'x'.repeat(65),
  42,
  { $ne: null },
];

describe.each([
  ['uploadCertification', uploadCertification, 'certification', { certificationType: 'vca' }],
  ['uploadQuestionAttachment', uploadQuestionAttachment, 'attachment', { questionId: 'q1' }],
] as const)('%s project folder', (_name, handler, fileType, extra) => {
  beforeEach(() => {
    uploadProjectFile.mockReset();
    uploadProjectFile.mockImplementation(fakeUpload);
  });

  it.each(MALFORMED.map((value) => [JSON.stringify(value), value]))(
    'stores a malformed projectId %s under temp',
    async (_label, projectId) => {
      const result = await call(handler, { projectId, ...extra });
      expect(result.projectId).toBe('temp');
      expect(result.fileType).toBe(fileType);
      expect(result.userId).toBe(OWNER);
      expect(result.key.startsWith(`projects/temp/${fileType}/${OWNER}/`)).toBe(true);
      // The upload can never be shaped into signable project media,
      // neither for the uploader nor under another owner's media prefix.
      expect(projectMediaKeyFor(result.url, OWNER)).toBeNull();
      expect(projectMediaKeyFor(result.url, VICTIM)).toBeNull();
      expect(result.data).toMatchObject(extra);
    },
  );

  it('keeps a valid project id and the file type unchanged', async () => {
    const result = await call(handler, { projectId: '6650aa_B-1', ...extra });
    expect(result.projectId).toBe('6650aa_B-1');
    expect(result.fileType).toBe(fileType);
    expect(result.key.startsWith(`projects/6650aa_B-1/${fileType}/${OWNER}/`)).toBe(true);
    expect(projectMediaKeyFor(result.url, OWNER)).toBeNull();
  });

  it('falls back to temp when no projectId is sent', async () => {
    const result = await call(handler, { ...extra });
    expect(result.projectId).toBe('temp');
    expect(result.fileType).toBe(fileType);
  });
});
