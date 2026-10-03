// A small Python pickle reader (protocols 2-5) for plain data: dicts, lists, tuples, sets, str, bytes, int, float,
// bool, None. dimos publishes /resource_stats (the dtop worker table) as a pickled dict, and this is all it holds.
// Anything else (class instances, globals) throws, so a payload we can't read never turns into a wrong reading.

const MARK = Symbol("mark")

export function unpickle(bytes: Uint8Array): unknown {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const text = new TextDecoder()
    const stack: unknown[] = []
    const memo: unknown[] = []
    let at = 0
    const u8 = () => bytes[at++]
    const u16 = () => (at += 2, view.getUint16(at - 2, true))
    const u32 = () => (at += 4, view.getUint32(at - 4, true))
    const u64 = () => (at += 8, Number(view.getBigUint64(at - 8, true)))
    const take = (length: number) => {
        if (at + length > bytes.length) {
            throw new Error("pickle: truncated")
        }
        return bytes.subarray(at, at += length)
    }
    const long = (raw: Uint8Array) => {
        let value = 0n
        for (let i = raw.length - 1; i >= 0; i--) {
            value = (value << 8n) | BigInt(raw[i])
        }
        if (raw.length && raw[raw.length - 1] & 0x80) {
            value -= 1n << BigInt(raw.length * 8)
        }
        return Number(value)
    }
    const popMark = () => {
        const index = stack.lastIndexOf(MARK)
        if (index === -1) {
            throw new Error("pickle: no mark")
        }
        return stack.splice(index).slice(1)
    }
    const top = () => stack[stack.length - 1]
    const setItems = (dict: Record<string, unknown>, items: unknown[]) => {
        for (let i = 0; i + 1 < items.length; i += 2) {
            dict[String(items[i])] = items[i + 1]
        }
    }
    while (at < bytes.length) {
        const op = u8()
        switch (op) {
            case 0x80: // PROTO
                at += 1
                break
            case 0x95: // FRAME
                at += 8
                break
            case 0x2e: // STOP
                return stack.pop()
            case 0x7d: // EMPTY_DICT
                stack.push({})
                break
            case 0x5d: // EMPTY_LIST
                stack.push([])
                break
            case 0x29: // EMPTY_TUPLE
                stack.push([])
                break
            case 0x8f: // EMPTY_SET
                stack.push([])
                break
            case 0x28: // MARK
                stack.push(MARK)
                break
            case 0x4e: // NONE
                stack.push(null)
                break
            case 0x88: // NEWTRUE
                stack.push(true)
                break
            case 0x89: // NEWFALSE
                stack.push(false)
                break
            case 0x4b: // BININT1
                stack.push(u8())
                break
            case 0x4d: // BININT2
                stack.push(u16())
                break
            case 0x4a: // BININT
                at += 4
                stack.push(view.getInt32(at - 4, true))
                break
            case 0x8a: // LONG1
                stack.push(long(take(u8())))
                break
            case 0x8b: // LONG4
                stack.push(long(take(u32())))
                break
            case 0x47: // BINFLOAT
                at += 8
                stack.push(view.getFloat64(at - 8, false))
                break
            case 0x8c: // SHORT_BINUNICODE
                stack.push(text.decode(take(u8())))
                break
            case 0x58: // BINUNICODE
                stack.push(text.decode(take(u32())))
                break
            case 0x8d: // BINUNICODE8
                stack.push(text.decode(take(u64())))
                break
            case 0x43: // SHORT_BINBYTES
                stack.push(take(u8()).slice())
                break
            case 0x42: // BINBYTES
                stack.push(take(u32()).slice())
                break
            case 0x94: // MEMOIZE
                memo.push(top())
                break
            case 0x71: // BINPUT
                memo[u8()] = top()
                break
            case 0x72: // LONG_BINPUT
                memo[u32()] = top()
                break
            case 0x68: // BINGET
                stack.push(memo[u8()])
                break
            case 0x6a: // LONG_BINGET
                stack.push(memo[u32()])
                break
            case 0x73: { // SETITEM
                const value = stack.pop()
                const key = stack.pop()
                setItems(top() as Record<string, unknown>, [key, value])
                break
            }
            case 0x75: { // SETITEMS
                const items = popMark()
                setItems(top() as Record<string, unknown>, items)
                break
            }
            case 0x61: { // APPEND
                const value = stack.pop()
                ;(top() as unknown[]).push(value)
                break
            }
            case 0x65: // APPENDS
            case 0x90: { // ADDITEMS
                const items = popMark()
                ;(top() as unknown[]).push(...items)
                break
            }
            case 0x74: // TUPLE
            case 0x91: // FROZENSET
                stack.push(popMark())
                break
            case 0x85: // TUPLE1
                stack.push(stack.splice(-1))
                break
            case 0x86: // TUPLE2
                stack.push(stack.splice(-2))
                break
            case 0x87: // TUPLE3
                stack.push(stack.splice(-3))
                break
            default:
                throw new Error(`pickle: unsupported opcode 0x${op.toString(16)} (not plain data)`)
        }
    }
    throw new Error("pickle: no STOP")
}
