import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

// Writers for test archives, including hostile ones (zip slip, links, devices, bombs). Every
// payload is an inert string; nothing here is real malware.

export interface ZipItem {
  name: string
  data?: Buffer | string
  /** Unix mode in the external attributes, e.g. 0o120777 for a symlink. */
  mode?: number
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8
  /** Set the "encrypted" flag (the data is not really encrypted). */
  encrypted?: boolean
}

export function makeZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8')
    const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '')
    const method = item.method ?? 8
    const body = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const flags = 0x800 | (item.encrypted ? 1 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

export interface TarItem {
  name: string
  data?: Buffer | string
  /** Tar type flag: '0' file (default), '1' hard link, '2' symlink, '3' char device, '5' folder, '6' FIFO. */
  type?: string
  linkname?: string
}

function header(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100, 'latin1')
  h.write('0000000\0', 108, 'latin1')
  h.write('0000000\0', 116, 'latin1')
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  h.write('14000000000\0', 136, 'latin1')
  h.write('        ', 148, 'latin1')
  h.write(type, 156, 'latin1')
  h.write(linkname, 157, 100, 'utf8')
  h.write('ustar\0', 257, 'latin1')
  h.write('00', 263, 'latin1')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return h
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512)

/** A tar; names over 100 bytes get a pax header. */
export function makeTar(items: TarItem[]): Buffer {
  const parts: Buffer[] = []
  for (const item of items) {
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '')
    let name = item.name
    if (Buffer.byteLength(name) > 100) {
      const body = `path=${name}\n`
      const bytes = Buffer.byteLength(body)
      // The length counts its own digits.
      let len = bytes + 2
      while (String(len).length + 1 + bytes !== len) len = String(len).length + 1 + bytes
      const record = Buffer.from(`${len} ${body}`, 'utf8')
      parts.push(header('PaxHeader', record.length, 'x'), record, pad(record.length))
      name = 'long-name-in-pax'
    }
    const type = item.type ?? '0'
    const size = type === '0' ? data.length : 0
    parts.push(header(name, size, type, item.linkname), size ? data : Buffer.alloc(0), pad(size))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export const makeTarGz = (items: TarItem[]) => gzipSync(makeTar(items))

/** A minimal WordPress dump: site address, one post, one attachment at 2026/01/photo.png. */
export const WP_DUMP = `-- MySQL dump
INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://old.example','yes'),(2,'home','https://old.example','yes');
INSERT INTO \`wp_posts\` VALUES (5,1,'2026-01-01 10:00:00','2026-01-01 10:00:00','','Photo','','inherit','open','closed','','photo','','','2026-01-01 10:00:00','2026-01-01 10:00:00','',0,'',0,'attachment','image/png',0),(7,1,'2026-01-01 10:00:00','2026-01-01 10:00:00','<p>Hi</p>','Hello','','publish','open','open','','hello','','','2026-01-01 10:00:00','2026-01-01 10:00:00','',0,'',0,'post','',0);
INSERT INTO \`wp_postmeta\` VALUES (1,5,'_wp_attached_file','2026/01/photo.png'),(2,7,'_thumbnail_id','5');
`
