import createDebug from './debug'
const debug = createDebug('pnpm:install')
import npa = require('npm-package-arg')
import fs = require('mz/fs')
import {Stats} from 'fs'
import logger = require('@zkochan/logger')

import path = require('path')
const join = path.join
const dirname = path.dirname
const basename = path.basename
const abspath = path.resolve

import fetch from './fetch'
import resolve, {ResolveResult, PackageDist} from './resolve'

import mkdirp from './fs/mkdirp'
import requireJson from './fs/require_json'
import relSymlink from './fs/rel_symlink'

import linkBundledDeps from './install/link_bundled_deps'
import isAvailable from './install/is_available'
import installAll from './install_multiple'
import {InstallContext, CachedPromises} from './api/install'
import {Package} from './api/init_cmd'

export type PackageMeta = {
  rawSpec: string,
  optional: boolean
}

export type InstallationOptions = {
  ignoreScripts: boolean,
  optional?: boolean,
  keypath?: string[],
  parentRoot?: string
}

type InstallationPaths = {
  modules: string,
  target?: string
}

export type PackageSpec = {
  raw: string,
  name: string,
  scope: string,
  type: string,
  spec: string,
  rawSpec: string,
  hosted?: {
    type: string,
    shortcut: string
  }
}

export type PackageContext = {
  spec: PackageSpec,
  optional: boolean,
  keypath: string[],
  fullname?: string,
  dist?: PackageDist,
  data: Object,
  name: string,
  version: string,
  root?: string,
  ignoreScripts: boolean
}

export type InstallLog = (msg: string, data?: Object) => void

/*
 * Installs a package.
 *
 *     install(ctx, 'rimraf@2', './node_modules')
 *
 * Parameters:
 *
 * - `ctx` (Object) - the context.
 *   - `root` (String) - root path of the package.
 *   - `log` (Function) - logger
 *
 * What it does:
 *
 * - resolve() - resolve from registry.npmjs.org
 * - fetch() - download tarball into node_modules/.store/{name}@{version}
 * - recurse into its dependencies
 * - symlink node_modules/{name}
 * - symlink bins
 */

export default async function install (ctx: InstallContext, pkgMeta: PackageMeta, modules: string, options: InstallationOptions): Promise<PackageContext> {
  debug('installing ' + pkgMeta.rawSpec)
  if (!ctx.builds) ctx.builds = {}
  if (!ctx.fetches) ctx.fetches = {}

  const pkg: PackageContext = {
    name: undefined,
    version: undefined,

    ignoreScripts: options.ignoreScripts === true,

    // Preliminary spec data
    // => { raw, name, scope, type, spec, rawSpec }
    spec: npa(pkgMeta.rawSpec),

    optional: pkgMeta.optional || options.optional,

    // Dependency path to the current package. Not actually needed anmyore
    // outside getting its length
    // => ['babel-core@6.4.5', 'babylon@6.4.5', 'babel-runtime@5.8.35']
    keypath: (options && options.keypath || []),

    // Full name of package as it should be put in the store. Aim to make
    // this as friendly as possible as this will appear in stack traces.
    // => 'lodash@4.0.0'
    // => '@rstacruz!tap-spec@4.1.1'
    // => 'rstacruz!pnpm@0a1b382da'
    // => 'foobar@9a3b283ac'
    fullname: undefined,

    // Distribution data from resolve() => { shasum, tarball }
    dist: undefined,

    // package.json data as retrieved from resolve() => { name, version, ... }
    data: undefined
  }

  const paths: InstallationPaths = {
    // Module storage => './node_modules'
    modules,

    // Final destination => store + '/lodash@4.0.0'
    target: undefined
  }

  const log: InstallLog = logger.fork(pkg.spec).log.bind(null, 'progress', pkgMeta.rawSpec)

  try {
    // it might be a bundleDependency, in which case, don't bother
    const available = await isAvailable(pkg.spec, modules)
    if (available) {
      const data = await saveCachedResolution()
      log('package.json', data)
    } else {
      const res = await resolve(Object.assign({}, pkg.spec, {root: options.parentRoot || ctx.root}), {log, got: ctx.got})
      saveResolution(res)
      log('resolved', pkg)
      await buildToStoreCached(ctx, paths, pkg, log)
      await mkdirp(paths.modules)
      await symlinkToModules(join(paths.target, '_'), paths.modules)
      log('package.json', requireJson(join(paths.target, '_', 'package.json')))
    }

    if (!ctx.installs) ctx.installs = {}
    if (!ctx.installs[pkg.fullname]) {
      ctx.installs[pkg.fullname] = pkg
    } else {
      ctx.installs[pkg.fullname].optional = ctx.installs[pkg.fullname].optional && pkg.optional
    }

    log('done')
    return pkg
  } catch (err) {
    log('error', err)
    throw err
  }

  // set metadata as fetched from resolve()
  function saveResolution (res: ResolveResult) {
    pkg.name = res.name
    pkg.fullname = res.fullname
    pkg.version = res.version
    pkg.dist = res.dist
    pkg.root = res.root
    paths.target = join(ctx.store, res.fullname)
  }

  async function saveCachedResolution (): Promise<Package> {
    const target = join(modules, pkg.spec.name)
    const stat: Stats = await fs.lstat(target)
    if (stat.isSymbolicLink()) {
      const path = await fs.readlink(target)
      return save(abspath(path, target))
    }
    return save(target)

    function save (fullpath: string): Package {
      const data = requireJson(join(fullpath, 'package.json'))
      pkg.name = data.name
      pkg.fullname = basename(fullpath)
      pkg.version = data.version
      pkg.data = data
      paths.target = fullpath
      return data
    }
  }
}

/*
 * Builds to `.store/lodash@4.0.0` (paths.target)
 * If an ongoing build is already working, use it. Also, if that ongoing build
 * is part of the dependency chain (ie, it's a circular dependency), use its stub
 */

function buildToStoreCached (ctx: InstallContext, paths: InstallationPaths, pkg: PackageContext, log: InstallLog) {
  // If a package is requested for a second time (usually when many packages depend
  // on the same thing), only resolve until it's fetched (not built).
  if (ctx.fetches[pkg.fullname]) return ctx.fetches[pkg.fullname]

  return make(paths.target, () =>
    memoize(ctx.builds, pkg.fullname, async function () {
      await memoize(ctx.fetches, pkg.fullname, () => fetchToStore(ctx, paths, pkg, log))
      return buildInStore(ctx, paths, pkg, log)
    })
  )
}

/*
 * Builds to `.store/lodash@4.0.0` (paths.target)
 * Fetches from npm, recurses to dependencies, runs lifecycle scripts, etc
 */

async function fetchToStore (ctx: InstallContext, paths: InstallationPaths, pkg: PackageContext, log: InstallLog) {
  // download and untar
  log('download-queued')
  await mkdirp(join(paths.target, '_'))
  await fetch(join(paths.target, '_'), pkg.dist, {log, got: ctx.got})
  if (pkg.dist.local && pkg.dist.remove) {
    await fs.unlink(pkg.dist.tarball)
  }

  // TODO: this is the point it becomes partially useable.
  // ie, it can now be symlinked into .store/foo@1.0.0.
  // it is only here that it should be available for ciruclar dependencies.
}

async function buildInStore (ctx: InstallContext, paths: InstallationPaths, pkg: PackageContext, log: InstallLog) {
  let fulldata: Package

  fulldata = requireJson(abspath(join(paths.target, '_', 'package.json')))
  log('package.json', fulldata)

  await linkBundledDeps(join(paths.target, '_'))

  // recurse down to dependencies
  log('dependencies')
  await installAll(ctx,
    fulldata.dependencies,
    fulldata.optionalDependencies,
    join(paths.target, '_', 'node_modules'),
    {
      keypath: pkg.keypath.concat([ pkg.fullname ]),
      dependent: pkg.fullname,
      parentRoot: pkg.root,
      optional: pkg.optional,
      ignoreScripts: pkg.ignoreScripts
    })

  // symlink itself; . -> node_modules/lodash@4.0.0
  // this way it can require itself
  await symlinkSelf(paths.target, fulldata, pkg.keypath.length)

  ctx.piq = ctx.piq || []
  ctx.piq.push({
    path: paths.target,
    pkgFullname: pkg.fullname
  })
}

/*
 * Symlink a package into its own node_modules. this way, babel-runtime@5 can
 * require('babel-runtime') within itself.
 */

async function symlinkSelf (target: string, pkg: Package, depth: number) {
  debug(`symlinkSelf ${pkg.name}`)
  if (depth === 0) {
    return
  }
  await mkdirp(join(target, 'node_modules'))
  await relSymlink(
    join('..', '_'),
    join(target, 'node_modules', escapeName(pkg.name)))
}

function escapeName (name: string) {
  return name && name.replace('/', '%2f')
}

/*
 * Perform the final symlinking of ./.store/x@1.0.0 -> ./x.
 *
 *     target = '/node_modules/.store/lodash@4.0.0'
 *     modules = './node_modules'
 *     symlinkToModules(fullname, modules)
 */

async function symlinkToModules (target: string, modules: string) {
  // TODO: uncomment to make things fail
  const pkgData = requireJson(join(target, 'package.json'))
  if (!pkgData.name) { throw new Error('Invalid package.json for ' + target) }

  // lodash -> .store/lodash@4.0.0
  // .store/foo@1.0.0/node_modules/lodash -> ../../../.store/lodash@4.0.0
  const out = join(modules, pkgData.name)
  await mkdirp(dirname(out))
  await relSymlink(target, out)
}

/*
 * If `path` doesn't exist, run `fn()`.
 * If it exists, don't do anything.
 */

async function make (path: string, fn: Function) {
  try {
    await fs.stat(path)
  } catch (err) {
    if ((<NodeJS.ErrnoException>err).code !== 'ENOENT') throw err
    return fn()
  }
}

/*
 * Save promises for later
 */

function memoize (locks: CachedPromises, key: string, fn: () => Promise<void>) {
  if (locks && locks[key]) return locks[key]
  locks[key] = fn()
  return locks[key]
}
