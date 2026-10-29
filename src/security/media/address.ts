import { isIP } from 'node:net'

// Address classification for the SSRF guard (doc 12.6 item 2, T9).
// Fails closed: anything that is not a parseable, globally routable unicast address is "reserved".

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

const v4ToInt = (a: string): number => a.split('.').reduce((n, p) => n * 256 + Number(p), 0)

function v4Reserved(a: string): boolean {
  const n = v4ToInt(a)
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    const start = v4ToInt(base)
    return n >= start && n < start + size
  })
}

/** Expands an IPv6 address (optionally with a trailing dotted IPv4) to 8 16-bit groups. */
function v6Groups(a: string): number[] | undefined {
  let s = a.toLowerCase().split('%')[0] ?? ''
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted?.[1]) {
    const n = v4ToInt(dotted[1])
    s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((g) => Number.parseInt(g, 16)))
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 0) return undefined
  const g = [...head, ...Array<number>(fill).fill(0), ...tail]
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : undefined
}

const groupsToV4 = (g: number[]): string => {
  const hi = g[6] ?? 0
  const lo = g[7] ?? 0
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export function isPrivateOrReserved(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, '')
  const kind = isIP(a)
  if (kind === 4) return v4Reserved(a)
  if (kind !== 6) return true
  const g = v6Groups(a)
  if (!g) return true
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (upperZero && g5 === 0xffff) return v4Reserved(groupsToV4(g)) // ::ffff:a.b.c.d (IPv4-mapped)
  if (upperZero && g5 === 0) return true // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return true // NAT64 can reach internal IPv4 (64:ff9b::/96, /48)
  if (g0 === 0x2002) return true // 6to4 embeds an arbitrary IPv4
  if (g0 === 0x2001 && g1 === 0x0db8) return true // documentation
  if (g0 === 0x2001 && g1 < 0x200) return true // 2001::/23 IETF special-purpose (incl. Teredo)
  if ((g0 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true // deprecated site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  return (g0 & 0xe000) !== 0x2000 // only 2000::/3 is global unicast
}

/** Narrow check for the source-host plain-http exception: loopback or RFC 1918/ULA only. */
export function isLoopbackOrPrivateOnly(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, '')
  if (isIP(a) === 4) {
    const n = v4ToInt(a)
    const inBlock = (base: string, bits: number) => n >= v4ToInt(base) && n < v4ToInt(base) + 2 ** (32 - bits)
    return inBlock('127.0.0.0', 8) || inBlock('10.0.0.0', 8) || inBlock('172.16.0.0', 12) || inBlock('192.168.0.0', 16)
  }
  if (isIP(a) !== 6) return false
  const g = v6Groups(a)
  if (!g) return false
  const upperZero = g.slice(0, 5).every((x) => x === 0)
  if (upperZero && g[5] === 0xffff) return isLoopbackOrPrivateOnly(groupsToV4(g))
  if (upperZero && g[5] === 0 && g[6] === 0 && g[7] === 1) return true // ::1
  return ((g[0] ?? 0) & 0xfe00) === 0xfc00
}
