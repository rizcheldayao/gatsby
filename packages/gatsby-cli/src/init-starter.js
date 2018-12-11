/* @flow */
const { execSync } = require(`child_process`)
const execa = require(`execa`)
const hostedGitInfo = require(`hosted-git-info`)
const fs = require(`fs-extra`)
const sysPath = require(`path`)
const report = require(`./reporter`)
const url = require(`url`)
const existsSync = require(`fs-exists-cached`).sync
const semver = require(`semver`)

const spawn = (cmd: string) => {
  const [file, ...args] = cmd.split(/\s+/)
  return execa(file, args, { stdio: `inherit` })
}

// Checks the existence of yarn package
// We use yarnpkg instead of yarn to avoid conflict with Hadoop yarn
// Refer to https://github.com/yarnpkg/yarn/issues/673
//
// Returns true if yarn exists, false otherwise
const shouldUseYarn = () => {
  try {
    execSync(`yarnpkg --version`, { stdio: `ignore` })
    return true
  } catch (e) {
    return false
  }
}

function checkYarnVersion() {
  let hasMinYarnPnp = false
  let yarnVersion = null
  try {
    yarnVersion = execSync(`yarnpkg --version`)
      .toString()
      .trim()
    let trimmedYarnVersion = /^(.+?)[-+].+$/.exec(yarnVersion)
    if (trimmedYarnVersion) {
      trimmedYarnVersion = trimmedYarnVersion.pop()
    }
    hasMinYarnPnp = semver.gte(trimmedYarnVersion || yarnVersion, `1.12.0`)
  } catch (err) {
    // ignore
  }
  return {
    hasMinYarnPnp: hasMinYarnPnp,
    yarnVersion: yarnVersion,
  }
}

// Executes `npm install` or `yarn install` in rootPath.
const install = async (rootPath: string, usePnp: boolean) => {
  const prevDir = process.cwd()

  report.info(`Installing packages...`)
  process.chdir(rootPath)
  const pnpCommand = usePnp ? `--enable-pnp` : ``
  const pnpText = usePnp
    ? `Using Plug'n'Play took`
    : `Installing node modules took`
  try {
    const startTime = new Date().getTime()
    let cmd = shouldUseYarn()
      ? spawn(`yarnpkg ${pnpCommand}`)
      : spawn(`npm install`)
    await cmd
    const endTime = new Date().getTime()
    const totalTime = ((endTime - startTime) / 1000).toFixed(2)
    report.info(`${pnpText} ${totalTime} seconds`)
  } finally {
    process.chdir(prevDir)
  }
}

const ignored = path => !/^\.(git|hg)$/.test(sysPath.basename(path))

// Copy starter from file system.
const copy = async (starterPath: string, rootPath: string, usePnp: boolean) => {
  // Chmod with 755.
  // 493 = parseInt('755', 8)
  await fs.mkdirp(rootPath, { mode: 493 })

  if (!existsSync(starterPath)) {
    throw new Error(`starter ${starterPath} doesn't exist`)
  }

  if (starterPath === `.`) {
    throw new Error(
      `You can't create a starter from the existing directory. If you want to
      create a new site in the current directory, the trailing dot isn't
      necessary. If you want to create a new site from a local starter, run
      something like "gatsby new new-gatsby-site ../my-gatsby-starter"`
    )
  }

  report.info(`Creating new site from local starter: ${starterPath}`)

  report.log(`Copying local starter to ${rootPath} ...`)

  await fs.copy(starterPath, rootPath, { filter: ignored })

  report.success(`Created starter directory layout`)

  await install(rootPath, usePnp)

  return true
}

// Clones starter from URI.
const clone = async (hostInfo: any, rootPath: string, usePnp: boolean) => {
  let url
  // Let people use private repos accessed over SSH.
  if (hostInfo.getDefaultRepresentation() === `sshurl`) {
    url = hostInfo.ssh({ noCommittish: true })
    // Otherwise default to normal git syntax.
  } else {
    url = hostInfo.https({ noCommittish: true, noGitPlus: true })
  }

  const branch = hostInfo.committish ? `-b ${hostInfo.committish}` : ``

  report.info(`Creating new site from git: ${url}`)

  await spawn(`git clone ${branch} ${url} ${rootPath} --single-branch`)

  report.success(`Created starter directory layout`)

  await fs.remove(sysPath.join(rootPath, `.git`))

  await install(rootPath, usePnp)
}

type InitOptions = {
  rootPath?: string,
}

/**
 * Main function that clones or copies the starter.
 */
module.exports = async (
  starter: string,
  options: InitOptions = {},
  usePnp: boolean
) => {
  if (usePnp) {
    if (!shouldUseYarn()) {
      report.warning(`NPM does not support PnP`)
      usePnp = false
    } else {
      const yarnInfo = checkYarnVersion()
      if (!yarnInfo.hasMinYarnPnp) {
        if (yarnInfo.yarnVersion) {
          report.warning(
            `You are using Yarn ${
              yarnInfo.yarnVersion
            } together with the --use-pnp flag, but Plug'n'Play is only supported starting from the 1.12 release.\n\n` +
              `Please update to Yarn 1.12 or higher for a better, fully supported experience.\n`
          )
        }
        // 1.11 had an issue with webpack-dev-middleware, so better not use PnP with it (never reached stable, but still)
        usePnp = false
      }
    }
  }
  const rootPath = options.rootPath || process.cwd()
  const urlObject = url.parse(rootPath)
  if (urlObject.protocol && urlObject.host) {
    report.panic(
      `It looks like you forgot to add a name for your new project. Try running instead "gatsby new new-gatsby-project ${rootPath}"`
    )
    return
  }

  if (existsSync(sysPath.join(rootPath, `package.json`))) {
    report.panic(`Directory ${rootPath} is already an npm project`)
    return
  }

  const hostedInfo = hostedGitInfo.fromUrl(starter)
  if (hostedInfo) await clone(hostedInfo, rootPath, usePnp)
  else await copy(starter, rootPath, usePnp)
}
