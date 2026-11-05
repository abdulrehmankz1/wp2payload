import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { MediaError, SecurityError } from '../errors.js'

// Reads a media file from a backup's uploads folder (doc 12.7, T10). The relative path comes from
// the dump (`_wp_attached_file`), so it is untrusted: it must stay inside the folder after every
// link is resolved, name a regular file, and fit the size cap.

export async function readLocalMedia(uploadsDir: string, relPath: string, maxBytes: number): Promise<Buffer> {
  const rel = relPath.replace(/\\/g, '/')
  if (!rel || rel.includes('\0') || path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
    throw new SecurityError('SEC_PATH_TRAVERSAL', `Refused media path ${JSON.stringify(relPath.slice(0, 200))}: it leaves the uploads folder.`)
  }
  let root: string
  try {
    root = await realpath(uploadsDir)
  } catch {
    throw new MediaError('MEDIA_UPLOADS_MISSING', `The uploads folder ${uploadsDir} does not exist.`)
  }
  let file: string
  try {
    file = await realpath(path.join(root, ...rel.split('/')))
  } catch {
    throw new MediaError('MEDIA_404', `Not in the uploads folder: ${rel}`, 404)
  }
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new SecurityError('SEC_PATH_TRAVERSAL', `Refused media path ${JSON.stringify(rel)}: a link in it points outside the uploads folder.`)
  }
  // O_NOFOLLOW where the platform has it: the resolved path must not have become a link since.
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new MediaError('MEDIA_404', `Not a regular file in the uploads folder: ${rel}`, 404)
    if (st.size > maxBytes) throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is ${st.size} bytes, over the ${maxBytes}-byte cap.`)
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}
