/**
 * Rootless Chromium sysroot bootstrapper.
 *
 * The CI/agent runner image ships no Chromium system libraries, no fontconfig
 * and no fonts, and the runner user (uid 1000) has no root and no working apt.
 * That makes `playwright install chromium` download a browser that cannot
 * launch: `libglib-2.0.so.0: cannot open shared object file`.
 *
 * This script fixes that without root. It resolves the Debian dependency
 * closure for the Chromium runtime libraries straight from the archive
 * `Packages` index, downloads the `.deb` files, and unpacks them with
 * `dpkg-deb -x` into a user-writable sysroot. Nothing is installed into the
 * image; the browser finds the libraries through `LD_LIBRARY_PATH`.
 *
 * Usage:
 *   npx tsx scripts/chromium-sysroot.ts            # build the sysroot
 *   npx tsx scripts/chromium-sysroot.ts --print-env  # only print the env
 *   eval "$(npx tsx scripts/chromium-sysroot.ts --print-env)"
 *
 * The generated `env.sh` inside the sysroot is the stable integration point;
 * `scripts/browser-env.sh` sources it.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const MIRROR = process.env.DEBIAN_MIRROR ?? 'http://deb.debian.org/debian'
const SUITE = process.env.DEBIAN_SUITE ?? 'trixie'
const ARCH = 'amd64'

/**
 * Defaults to a gitignored directory inside the checkout, not `~/.cache`. On
 * the agent runners `HOME` and every `PAPERCLIP_*_SCRATCH_DIR` are per-run
 * temp directories that are deleted when the run ends, so caching there would
 * re-download ~115 MB of browser on every single heartbeat. The checkout
 * survives between runs.
 */
const REPO_ROOT = resolve(import.meta.dirname, '..')
const CACHE_ROOT =
  process.env.CHROMIUM_SYSROOT_DIR ?? join(REPO_ROOT, '.cache', 'chromium-sysroot')

const SYSROOT = join(CACHE_ROOT, 'root')
const DOWNLOADS = join(CACHE_ROOT, 'debs')
const BROWSERS = join(CACHE_ROOT, 'browsers')
const STAMP = join(CACHE_ROOT, 'stamp.json')

/**
 * Seeds are Playwright's documented Chromium host dependencies plus the font
 * stack. Fonts matter as much as the libraries here: without fontconfig and a
 * Thai-capable family every screenshot renders tofu boxes, which would make a
 * visual QA pass report font bugs that do not exist in the product.
 */
const SEEDS = [
  // Chromium runtime
  'libglib2.0-0t64',
  'libnss3',
  'libnspr4',
  'libdbus-1-3',
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libcups2t64',
  'libdrm2',
  'libxkbcommon0',
  'libatspi2.0-0t64',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxrandr2',
  'libxext6',
  'libx11-6',
  'libxcb1',
  'libxshmfence1',
  'libgbm1',
  'libexpat1',
  'libpango-1.0-0',
  'libcairo2',
  'libasound2t64',
  'libudev1',
  // Font stack
  'fontconfig',
  'fonts-liberation',
  'fonts-dejavu-core',
  'fonts-thai-tlwg',
  // The child-facing UI leans on emoji. Without this every emoji screenshots as
  // a tofu box and a visual QA pass files font bugs that do not exist on a phone.
  'fonts-noto-color-emoji',
]

/**
 * Only libraries, fonts and a few pure-data packages are unpacked. This keeps
 * the closure from dragging in `perl`, `dpkg`, `debconf` and friends, which are
 * maintainer-script packages that cannot work unpacked without root anyway.
 */
const ALLOWED_NON_LIB = new Set([
  'fontconfig',
  'fontconfig-config',
  'xkb-data',
  'shared-mime-info',
  'sensible-utils',
  'x11-common',
])

const isAllowed = (name: string) =>
  name.startsWith('lib') || name.startsWith('fonts-') || ALLOWED_NON_LIB.has(name)

type Pkg = {
  name: string
  version: string
  filename: string
  sha256: string
  depends: string[]
  provides: string[]
}

function log(msg: string) {
  process.stderr.write(`[chromium-sysroot] ${msg}\n`)
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Split a Debian relationship field, dropping version constraints. */
function parseRelations(field: string | undefined): string[] {
  if (!field) return []
  return field
    .split(',')
    .map((clause) =>
      // Alternatives (`a | b`): take the first, which is the maintainer's preference.
      clause.split('|')[0].trim().split(/[\s(\[]/)[0].trim(),
    )
    .filter(Boolean)
}

function parsePackagesIndex(raw: string): Map<string, Pkg> {
  const index = new Map<string, Pkg>()
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue
    const fields: Record<string, string> = {}
    let key = ''
    for (const line of block.split('\n')) {
      if (/^\s/.test(line)) {
        if (key) fields[key] += ` ${line.trim()}`
        continue
      }
      const sep = line.indexOf(':')
      if (sep === -1) continue
      key = line.slice(0, sep)
      fields[key] = line.slice(sep + 1).trim()
    }
    const name = fields.Package
    if (!name || !fields.Filename) continue
    // The index lists every version; the archive `Packages` file is ordered so
    // the last entry wins, which matches what apt would install.
    index.set(name, {
      name,
      version: fields.Version ?? '',
      filename: fields.Filename,
      sha256: fields.SHA256 ?? '',
      depends: parseRelations(fields.Depends),
      provides: parseRelations(fields.Provides),
    })
  }
  return index
}

function installedPackages(): Set<string> {
  const out = execFileSync('dpkg-query', ['-W', '-f=${Package} ${Status}\n'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const installed = new Set<string>()
  for (const line of out.split('\n')) {
    const [name, , , state] = line.split(' ')
    if (name && state === 'installed') installed.add(name)
  }
  return installed
}

/** Breadth-first dependency closure, skipping anything the image already has. */
function resolveClosure(index: Map<string, Pkg>, installed: Set<string>): Pkg[] {
  const providedByInstalled = new Set<string>()
  for (const name of installed) {
    for (const virt of index.get(name)?.provides ?? []) providedByInstalled.add(virt)
  }

  const selected = new Map<string, Pkg>()
  const queue = [...SEEDS]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    if (installed.has(name) || providedByInstalled.has(name)) continue
    if (!isAllowed(name)) continue

    const pkg = index.get(name)
    if (!pkg) {
      // Virtual package: satisfy it with any real provider we can use.
      const provider = [...index.values()].find(
        (candidate) => candidate.provides.includes(name) && isAllowed(candidate.name),
      )
      if (!provider) {
        log(`skip: no candidate for "${name}"`)
        continue
      }
      queue.push(provider.name)
      continue
    }

    selected.set(name, pkg)
    queue.push(...pkg.depends)
  }

  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function downloadDeb(pkg: Pkg): Promise<string> {
  const target = join(DOWNLOADS, `${pkg.name}_${pkg.version.replace(/[:/]/g, '_')}.deb`)
  if (existsSync(target)) {
    const have = createHash('sha256').update(readFileSync(target)).digest('hex')
    if (!pkg.sha256 || have === pkg.sha256) return target
    rmSync(target)
  }
  const body = await fetchBuffer(`${MIRROR}/${pkg.filename}`)
  const digest = createHash('sha256').update(body).digest('hex')
  if (pkg.sha256 && digest !== pkg.sha256) {
    throw new Error(`checksum mismatch for ${pkg.name}: expected ${pkg.sha256}, got ${digest}`)
  }
  writeFileSync(target, body)
  return target
}

/**
 * Debian activates fontconfig rules by symlinking `conf.avail/*.conf` into
 * `conf.d` from a maintainer script — which never runs here, because we unpack
 * `.deb` files instead of installing them. Without those rules fontconfig has
 * no definition for the generic families, so `emoji` resolves to a Thai serif
 * face and every emoji in the UI screenshots as a tofu box.
 *
 * This is Debian's own default selection, minus the interactive hinting and
 * sub-pixel variants (which are mutually exclusive alternatives).
 */
const DEFAULT_CONF = [
  '10-hinting-slight.conf',
  '10-scale-bitmap-fonts.conf',
  '11-lcdfilter-default.conf',
  '20-unhint-small-vera.conf',
  '30-metric-aliases.conf',
  '40-nonlatin.conf',
  '45-generic.conf',
  '45-latin.conf',
  '48-spacing.conf',
  '49-sansserif.conf',
  '60-generic.conf',
  '60-latin.conf',
  '65-nonlatin.conf',
  '69-unifont.conf',
  // Noto Color Emoji is a CBDT bitmap font; the plain no-bitmaps rule would drop it.
  '70-no-bitmaps-except-emoji.conf',
  '90-synthetic.conf',
]

/** Rules shipped by the font packages themselves (Thai, Khmer, synthetic faces). */
const FONT_PACKAGE_CONF = /^(6[45]-|89-)/

/**
 * fontconfig's shipped config points at `/usr/share/fonts`, which is empty in
 * this image. Point it at the sysroot copy instead so Chromium finds real
 * Latin, Thai and emoji families.
 */
function writeFontConfig() {
  const fontsDir = join(SYSROOT, 'usr/share/fonts')
  const availDir = join(SYSROOT, 'usr/share/fontconfig/conf.avail')
  const confDir = join(SYSROOT, 'etc/fonts')
  const confD = join(confDir, 'conf.d')
  rmSync(confD, { recursive: true, force: true })
  mkdirSync(confD, { recursive: true })
  mkdirSync(join(CACHE_ROOT, 'fontcache'), { recursive: true })

  const available = existsSync(availDir) ? readdirSync(availDir) : []
  const activate = available.filter(
    (name) => DEFAULT_CONF.includes(name) || FONT_PACKAGE_CONF.test(name),
  )
  for (const name of activate) {
    symlinkSync(join(availDir, name), join(confD, name))
  }
  log(`activated ${activate.length} fontconfig rule files`)

  writeFileSync(
    join(confDir, 'fonts.conf'),
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${join(CACHE_ROOT, 'fontcache')}</cachedir>
  <include ignore_missing="yes">${confD}</include>
  <match target="pattern">
    <test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans</string></edit>
  </match>
  <!--
    Chromium asks for the "emoji" family by name for emoji runs. Bind it
    explicitly rather than relying on rule ordering.
  -->
  <alias binding="strong">
    <family>emoji</family>
    <prefer><family>Noto Color Emoji</family></prefer>
  </alias>
  <!-- ...and keep emoji as the last resort for text families, for inline emoji. -->
  <match target="pattern">
    <test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="append" binding="weak"><string>Noto Color Emoji</string></edit>
  </match>
</fontconfig>
`,
  )
}

function libraryPath(): string {
  return [
    join(SYSROOT, `usr/lib/x86_64-linux-gnu`),
    join(SYSROOT, `lib/x86_64-linux-gnu`),
    join(SYSROOT, 'usr/lib'),
  ].join(':')
}

function writeEnvFile() {
  const envPath = join(CACHE_ROOT, 'env.sh')
  writeFileSync(
    envPath,
    `# Generated by scripts/chromium-sysroot.ts — do not edit by hand.
export CHROMIUM_SYSROOT="${SYSROOT}"
export LD_LIBRARY_PATH="${libraryPath()}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export FONTCONFIG_PATH="${join(SYSROOT, 'etc/fonts')}"
export FONTCONFIG_FILE="${join(SYSROOT, 'etc/fonts/fonts.conf')}"
export PLAYWRIGHT_BROWSERS_PATH="${BROWSERS}"
`,
  )
  return envPath
}

function printEnv() {
  process.stdout.write(readFileSync(join(CACHE_ROOT, 'env.sh'), 'utf8'))
}

async function main() {
  if (process.argv.includes('--print-env')) {
    if (!existsSync(join(CACHE_ROOT, 'env.sh'))) {
      throw new Error(`sysroot not built yet; run: npx tsx scripts/chromium-sysroot.ts`)
    }
    printEnv()
    return
  }

  const force = process.argv.includes('--force')
  if (!force && existsSync(STAMP)) {
    const stamp = JSON.parse(readFileSync(STAMP, 'utf8')) as { seeds: string[] }
    if (stamp.seeds.join(',') === SEEDS.join(',')) {
      log('sysroot already built; use --force to rebuild')
      printEnv()
      return
    }
  }

  mkdirSync(SYSROOT, { recursive: true })
  mkdirSync(DOWNLOADS, { recursive: true })
  mkdirSync(BROWSERS, { recursive: true })

  log(`fetching package index for ${SUITE}/main/${ARCH}`)
  const gz = await fetchBuffer(`${MIRROR}/dists/${SUITE}/main/binary-${ARCH}/Packages.gz`)
  const index = parsePackagesIndex(gunzipSync(gz).toString('utf8'))
  log(`index has ${index.size} packages`)

  const closure = resolveClosure(index, installedPackages())
  log(`resolved ${closure.length} packages to unpack`)

  for (const pkg of closure) {
    const deb = await downloadDeb(pkg)
    execFileSync('dpkg-deb', ['-x', deb, SYSROOT], { stdio: ['ignore', 'ignore', 'inherit'] })
  }

  writeFontConfig()
  const envPath = writeEnvFile()
  writeFileSync(
    STAMP,
    JSON.stringify({ seeds: SEEDS, suite: SUITE, packages: closure.map((p) => p.name) }, null, 2),
  )

  log(`sysroot ready at ${SYSROOT}`)
  log(`env file: ${envPath}`)
  printEnv()
}

main().catch((err) => {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
