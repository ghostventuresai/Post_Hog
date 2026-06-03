import { Properties } from '~/plugin-scaffold'

import { isProductionEventOrigin } from './event-origin'

describe('isProductionEventOrigin()', () => {
    // [description, properties, expected]
    const cases: [string, Properties, boolean][] = [
        // --- Production: a positive public-host signal ---
        ['public domain', { $host: 'app.posthog.com' }, true],
        ['public domain with subdomain', { $host: 'eu.app.posthog.com' }, true],
        ['public domain with multi-part TLD', { $host: 'shop.example.co.uk' }, true],
        ['public domain with port', { $host: 'app.posthog.com:8080' }, true],
        ['public domain with standard https port', { $host: 'app.posthog.com:443' }, true],
        ['uppercased public domain is normalized', { $host: 'APP.POSTHOG.COM' }, true],
        ['public IPv4', { $host: '8.8.8.8' }, true],
        ['public IPv4 with port', { $host: '203.0.113.5:3000' }, true],
        ['public IPv4 just below private 172 range', { $host: '172.15.0.1' }, true],
        ['public IPv4 just above private 172 range', { $host: '172.32.0.1' }, true],
        ['public IPv6', { $host: '2606:4700:4700::1111' }, true],
        ['bracketed public IPv6 with port', { $host: '[2606:4700:4700::1111]:8443' }, true],
        ['bracketed public IPv6 without port', { $host: '[2606:4700:4700::1111]' }, true],
        ['IPv6 just past fe80::/10 (fec0 site-local) is not in reserved list', { $host: 'fec0::1' }, true],
        ['IPv4-mapped IPv6 with a public embedded IPv4', { $host: '::ffff:8.8.8.8' }, true],
        // $current_url with embedded credentials — URL parser strips userinfo.
        ['$current_url with credentials', { $current_url: 'https://user:pass@app.posthog.com/x' }, true],
        // Substring traps: "localhost" appears as a substring but the host is public.
        ['substring trap mylocalbiz.com', { $host: 'mylocalbiz.com' }, true],
        ['substring trap localhosting.com', { $host: 'localhosting.com' }, true],
        ['substring trap test in label', { $host: 'mytest.com' }, true],
        // $current_url fallback when $host is absent.
        ['$current_url public domain', { $current_url: 'https://app.posthog.com/insights?foo=bar' }, true],
        ['$current_url public domain with port', { $current_url: 'https://app.posthog.com:8080/path' }, true],
        // $host preferred over $current_url when both present.
        [
            '$host preferred over $current_url (host public)',
            { $host: 'app.posthog.com', $current_url: 'http://localhost:3000' },
            true,
        ],

        // --- Local / private / ambiguous: no fire ---
        ['no properties at all', {}, false],
        ['empty $host', { $host: '' }, false],
        ['whitespace-only $host', { $host: '   ' }, false],
        ['localhost', { $host: 'localhost' }, false],
        ['localhost with port', { $host: 'localhost:3000' }, false],
        ['subdomain of localhost', { $host: 'app.localhost' }, false],
        ['subdomain of localhost with port', { $host: 'app.localhost:8000' }, false],
        ['.local TLD', { $host: 'mymac.local' }, false],
        ['.test TLD', { $host: 'app.test' }, false],
        ['.internal TLD', { $host: 'service.internal' }, false],
        ['.invalid TLD', { $host: 'foo.invalid' }, false],
        ['.example TLD', { $host: 'foo.example' }, false],
        ['.localdomain TLD', { $host: 'localhost.localdomain' }, false],
        ['.home.arpa TLD', { $host: 'router.home.arpa' }, false],
        // Loopback / private / link-local IPv4
        ['0.0.0.0', { $host: '0.0.0.0' }, false],
        ['127.0.0.1 loopback', { $host: '127.0.0.1' }, false],
        ['127.x.x.x loopback range', { $host: '127.1.2.3' }, false],
        ['10.x private', { $host: '10.1.2.3' }, false],
        ['192.168 private', { $host: '192.168.1.1' }, false],
        ['172.16 private (low boundary)', { $host: '172.16.0.1' }, false],
        ['172.31 private (high boundary)', { $host: '172.31.255.255' }, false],
        ['169.254 link-local', { $host: '169.254.1.1' }, false],
        ['loopback IPv4 with port', { $host: '127.0.0.1:8000' }, false],
        // Loopback / unique-local / link-local IPv6
        ['unspecified IPv6 ::', { $host: '::' }, false],
        ['loopback IPv6 ::1', { $host: '::1' }, false],
        ['bracketed loopback IPv6 with port', { $host: '[::1]:3000' }, false],
        ['fc00::/7 unique-local', { $host: 'fc00::1' }, false],
        ['fd00::/7 unique-local', { $host: 'fd12:3456::1' }, false],
        ['fe80::/10 link-local', { $host: 'fe80::1' }, false],
        ['fe80::/10 link-local upper boundary (febf)', { $host: 'febf::1' }, false],
        ['bracketed link-local IPv6 with port', { $host: '[fe80::1]:8080' }, false],
        ['bracketed loopback IPv6 without port', { $host: '[::1]' }, false],
        ['IPv4-mapped IPv6 loopback fails closed', { $host: '::ffff:127.0.0.1' }, false],
        ['IPv4-mapped IPv6 private fails closed', { $host: '::ffff:192.168.1.1' }, false],
        ['bracketed IPv4-mapped IPv6 loopback with port', { $host: '[::ffff:127.0.0.1]:8080' }, false],
        // Bare single-label hostnames (machine names)
        ['bare single-label hostname', { $host: 'my-laptop' }, false],
        ['bare single-label hostname with port', { $host: 'my-laptop:3000' }, false],
        // Host-less origins
        ['file:// $current_url has no host', { $current_url: 'file:///Users/dev/index.html' }, false],
        ['non-string $host', { $host: 12345 }, false],
        ['unparseable $current_url', { $current_url: 'not a url' }, false],
        // $host preferred over $current_url when both present (host local).
        [
            '$host preferred over $current_url (host local)',
            { $host: 'localhost', $current_url: 'https://app.posthog.com' },
            false,
        ],
    ]

    it.each(cases)('%s', (_description, properties, expected) => {
        expect(isProductionEventOrigin(properties)).toBe(expected)
    })
})
