import { describe, expect, it, vi } from 'vitest';

const { getPresignedUrl, uploadToS3 } = vi.hoisted(() => ({
  getPresignedUrl: vi.fn(async () => 'https://signed.example/file'),
  uploadToS3: vi.fn(),
}));

vi.mock('../../../utils/s3Upload', () => ({
  getPresignedUrl,
  uploadToS3,
  deleteFromS3: vi.fn(async () => undefined),
  generateFileName: vi.fn((name: string, userId: string, type: string) => `${type}/${userId}/file${name.slice(name.lastIndexOf('.'))}`),
}));

import {
  presignSupportAttachment,
  sanitizeSupportFileName,
  validateSupportAttachmentBuffer,
} from '../../../utils/support/attachments';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]);
const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);

const file = (buffer: Buffer, mimetype: string, originalname: string): Express.Multer.File => ({
  buffer,
  mimetype,
  originalname,
  size: buffer.length,
} as Express.Multer.File);

describe('support attachment validation', () => {
  it('accepts real images/PDF and matching Office containers', async () => {
    await expect(validateSupportAttachmentBuffer(file(png, 'image/png', 'a.png'))).resolves.toMatchObject({ mimeType: 'image/png' });
    await expect(validateSupportAttachmentBuffer(file(pdf, 'application/pdf', 'a.pdf'))).resolves.toMatchObject({ mimeType: 'application/pdf' });
    await expect(validateSupportAttachmentBuffer(file(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'))).resolves.toBeDefined();
    await expect(validateSupportAttachmentBuffer(file(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'))).resolves.toBeDefined();
  });

  it('rejects spoofed content, wrong extensions and oversized files', async () => {
    await expect(validateSupportAttachmentBuffer(file(pdf, 'image/png', 'a.png'))).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION',
    });
    await expect(validateSupportAttachmentBuffer(file(Buffer.from('hello'), 'text/plain', 'a.csv'))).rejects.toMatchObject({
      status: 400,
    });
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    await expect(validateSupportAttachmentBuffer(file(huge, 'application/pdf', 'a.pdf'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('sanitizes the displayed filename without path traversal/control chars', () => {
    expect(sanitizeSupportFileName('../../etc/pass<wd>.pdf')).toBe('pass_wd_.pdf');
    expect(sanitizeSupportFileName('')).toBe('attachment');
  });

  it('presigns only private support-attachment objects', async () => {
    expect(await presignSupportAttachment('https://bucket.s3.eu-west-1.amazonaws.com/support-attachments/u/f.pdf')).toBe('https://signed.example/file');
    expect(getPresignedUrl).toHaveBeenCalledWith('support-attachments/u/f.pdf', 3600);
    expect(await presignSupportAttachment('https://bucket.s3.eu-west-1.amazonaws.com/profile-images/u/f.png')).toBeNull();
    expect(await presignSupportAttachment('not-a-url')).toBeNull();
  });
});
