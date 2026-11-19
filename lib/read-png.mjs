import { promisify } from 'node:util'
import { inflate } from 'node:zlib'

const decompress = promisify(inflate)
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(left, above, corner) {
  const estimate = left + above - corner
  const dl = Math.abs(estimate - left)
  const da = Math.abs(estimate - above)
  const dc = Math.abs(estimate - corner)
  if (dl <= da && dl <= dc) return left
  return da <= dc ? above : corner
}

// The two preview writers (Ghostscript png16m and encodePng) produce 8-bit,
// non-interlaced RGB. Compare their pixels directly, including subtle changes
// that only appear at the resolution the reader asked for.
export async function decodeRgbPng(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(signature) ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
      png[24] !== 8 || png[25] !== 2 || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) {
    throw new Error('unexpected PNG preview format')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const stride = 3 * width
  const bytes = height * (stride + 1)
  if (!width || !height || !Number.isSafeInteger(bytes)) throw new Error('invalid PNG dimensions')

  const compressed = []
  let complete = false
  for (let i = 33; i + 12 <= png.length;) {
    const size = png.readUInt32BE(i)
    const end = i + 8 + size
    if (end + 4 > png.length) break
    const type = png.toString('ascii', i + 4, i + 8)
    if (type === 'IDAT') compressed.push(png.subarray(i + 8, end))
    if (type === 'IEND') { complete = true; break }
    i = end + 4
  }
  if (!complete || !compressed.length) throw new Error('incomplete PNG preview')
  const data = await decompress(Buffer.concat(compressed), { maxOutputLength: bytes })
  if (data.length !== bytes) throw new Error('incomplete PNG scanlines')

  // Strip the filter byte as each row is reconstructed. The destination is
  // behind the input, so decoding in place saves an entire page-sized buffer.
  const firstRow = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const source = y * (stride + 1)
    const filter = data[source]
    const input = data.subarray(source + 1, source + 1 + stride)
    const row = data.subarray(y * stride, (y + 1) * stride)
    const above = y ? data.subarray((y - 1) * stride, y * stride) : firstRow
    if (filter === 0) {
      input.copy(row)
      continue
    }
    if (filter > 4) throw new Error('unknown PNG row filter')
    for (let i = 0; i < stride; i++) {
      const left = i < 3 ? 0 : row[i - 3]
      let predictor
      switch (filter) {
        case 1: predictor = left; break
        case 2: predictor = above[i]; break
        case 3: predictor = (left + above[i]) >> 1; break
        case 4: predictor = paeth(left, above[i], i < 3 ? 0 : above[i - 3]); break
      }
      row[i] = input[i] + predictor
    }
  }
  return { width, height, data: data.subarray(0, width * height * 3) }
}
