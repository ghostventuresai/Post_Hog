import { Properties } from '~/plugin-scaffold'

// Reserved / non-public TLD suffixes. A host ending in one of these is a dev or
// internal name, never a real public environment. Matched as an exact suffix
// (with the leading dot) so that production hosts which merely *contain* one of
// these words — mylocalbiz.com, localhosting.com — are not caught.
const RESERVED_TLD_SUFFIXES = ['.local', '.test', '.internal', '.invalid', '.example', '.localdomain', '.home.arpa']

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Decide whether an event's properties indicate it originated from a real, public
 * production environment — as opposed to a developer's localhost/dev setup.
 *
 * The only trustworthy origin signal is the browser's $host / $current_url, which
 * reflects the page the SDK is actually running on. $ip (and GeoIP derived from it)
 * cannot distinguish a developer's local backend from production, because a backend
 * on a laptop still reaches PostHog over the public internet from a public IP.
 *
 * Fail-closed: we return true only when there is a positive public-host signal.
 * No host, anything local/private/reserved, or anything ambiguous returns false.
 * A false positive (firing "production" for a dev event) silently corrupts the
 * activation metric and is hard to detect; a false negative is recoverable and rare.
 */
export function isProductionEventOrigin(properties: Properties): boolean {
    const rawHost = extractHost(properties)
    if (rawHost === null) {
        return false
    }

    const host = stripPortAndBrackets(rawHost.trim().toLowerCase())
    if (host.length === 0) {
        return false
    }

    return isPublicHost(host)
}

// Prefer $host (window.location.host) over $current_url (window.location.href).
// Returns null when there is no host signal at all — server-side, mobile, and
// file:// origins don't set one.
function extractHost(properties: Properties): string | null {
    const rawHost = properties.$host
    if (typeof rawHost === 'string' && rawHost.length > 0) {
        return rawHost
    }

    const currentUrl = properties.$current_url
    if (typeof currentUrl === 'string' && currentUrl.length > 0) {
        try {
            const host = new URL(currentUrl).host
            if (host.length > 0) {
                return host
            }
        } catch {
            // Not a parseable absolute URL — treat as no host signal.
        }
    }

    return null
}

// $host carries a port (localhost:3000, [::1]:3000). Strip brackets and the port
// so we classify the bare host. A bare IPv6 literal (>=2 colons, unbracketed) has
// no port to strip — only bracketed IPv6 can carry one.
function stripPortAndBrackets(host: string): string {
    if (host.startsWith('[')) {
        const closingBracket = host.indexOf(']')
        return closingBracket !== -1 ? host.slice(1, closingBracket) : host.slice(1)
    }

    const colonCount = host.split(':').length - 1
    if (colonCount >= 2) {
        return host // bare IPv6, no port
    }
    if (colonCount === 1) {
        return host.slice(0, host.indexOf(':')) // host:port
    }
    return host
}

function isPublicHost(host: string): boolean {
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return false
    }
    if (RESERVED_TLD_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return false
    }
    if (IPV4_RE.test(host)) {
        return isPublicIpv4(host)
    }
    if (host.includes(':')) {
        // Any remaining colon means a bare IPv6 literal at this point.
        return isPublicIpv6(host)
    }
    // A bare single-label hostname (a machine name like "my-laptop") isn't public.
    if (!host.includes('.')) {
        return false
    }
    // A dotted host that's neither reserved nor private — a real public domain.
    return true
}

function isPublicIpv4(host: string): boolean {
    const match = host.match(IPV4_RE)!
    const a = Number(match[1])
    const b = Number(match[2])

    if (a === 0) {
        return false // 0.0.0.0/8 ("this" network), includes 0.0.0.0
    }
    if (a === 127) {
        return false // 127.0.0.0/8 loopback
    }
    if (a === 10) {
        return false // 10.0.0.0/8 private
    }
    if (a === 192 && b === 168) {
        return false // 192.168.0.0/16 private
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return false // 172.16.0.0/12 private (172.15.x and 172.32.x are public)
    }
    if (a === 169 && b === 254) {
        return false // 169.254.0.0/16 link-local
    }
    return true
}

function isPublicIpv6(host: string): boolean {
    if (host === '::' || host === '::1') {
        return false // unspecified / loopback
    }

    // IPv4-mapped / IPv4-compatible IPv6 with a dotted tail (e.g. ::ffff:127.0.0.1) —
    // classify by the embedded IPv4 so a mapped loopback/private address fails closed.
    const lastSegment = host.slice(host.lastIndexOf(':') + 1)
    if (IPV4_RE.test(lastSegment)) {
        return isPublicIpv4(lastSegment)
    }

    const firstHextet = host.split(':')[0]
    if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) {
        return false // fc00::/7 unique-local
    }
    if (firstHextet.startsWith('fe')) {
        const nibble = firstHextet[2]
        if (nibble === '8' || nibble === '9' || nibble === 'a' || nibble === 'b') {
            return false // fe80::/10 link-local
        }
    }
    return true
}
