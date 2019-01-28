import * as path from 'path';

import { argv } from 'yargs';
import * as inquirer from 'inquirer';
import * as Listr from 'listr';
import * as listrInput from 'listr-input';
import * as pRetry from 'p-retry';
import { promisify } from 'util';
import * as req from 'request';
import * as shell from 'shelljs';
import * as semver from 'semver';

const request = promisify(req) as (options: req.OptionsWithUrl) => Promise<req.Response>;

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

/*
 * We only use these 3 values for now.
 * See also: https://docs.npmjs.com/cli/version#description.
 */

type SemverIncrement = 'patch' | 'minor' | 'major';

type ChangelogData = {
    releaseNotes: string;
    semverIncrement: SemverIncrement;
};

type Commit = {
    associatedIssues: string[];
    sha: string;
    tag: string;
    title: string;
};

type ExecResult = {
    code: number;
    stderr: string;
    stdout: string;
};

type GitHub = {
    token?: string;
    tokenID?: number;
    userName?: string;
    password?: string;
};

type TaskContext = {
    skipRemainingTasks: boolean;

    packagePath: string;
    packageName: string;

    changelogFilePath: string;
    commitSHAsSinceLastRelease?: Commit[];
    newPackageVersion?: string;
    npmPublishError?: any;
    packageJSONFilePath: string;
    packageLastTag?: string;
    packageLockJSONFilePath: string;
    packageNewTag?: string;
    packageReleaseNotes?: string;
    packageSemverIncrement?: string;
    packageVersion?: string;

    packageJSONFileContent: any;

    isUnpublishedPackage: boolean;
    isPrerelease: boolean;
};

type Task = {
    task: (ctx: TaskContext) => void;
    title: string;
};

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const GITHUB: GitHub = {};

const REPOSITORY_SLUG = 'webhintio/hint';
const REPOSITORY_URL = `https://github.com/${REPOSITORY_SLUG}`;

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

shell.config.silent = true;

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const exec = (cmd: string): Promise<ExecResult> => {
    return new Promise((resolve, reject) => {
        shell.exec(cmd, (code, stdout, stderr) => {
            const result = {
                code,
                stderr: stderr && stderr.trim(),
                stdout: stdout && stdout.trim()
            };

            if (code === 0) {
                return resolve(result);
            }

            return reject(result);
        });
    });
};

const execWithRetry = (cmd: string, retries: number = 2): Promise<ExecResult> => {
    const fn = () => {
        return exec(cmd);
    };

    return pRetry(fn, {
        onFailedAttempt: (error) => {
            console.error(`Failed executing "${cmd}". Retries left: ${(error as any).retriesLeft}.`);
        },
        retries
    });
};

const removePackageFiles = (dir: string = 'packages/*') => {
    shell.rm('-rf',
        `${dir}/dist`,
        `${dir}/node_modules`,
        `${dir}/npm-shrinkwrap.json`,
        `${dir}/package-lock.json`,
        `${dir}/yarn.lock`
    );
};

const cleanup = (ctx: TaskContext) => {
    removePackageFiles(ctx.packagePath);
    ctx = {} as TaskContext; // eslint-disable-line no-param-reassign
};

const createGitHubToken = async (showInitialMessage = true) => {

    if (showInitialMessage) {
        console.log('Create GitHub token\n');
    }

    const questions = [{
        message: 'GitHub username:',
        name: 'username',
        type: 'input'
    }, {
        message: 'GitHub password:',
        name: 'password',
        type: 'password'
    }, {
        message: 'GitHub OTP:',
        name: 'otp',
        type: 'input'
    }];

    const answers = await inquirer.prompt(questions) as inquirer.Answers;

    const res = await request({
        auth: {
            pass: answers.password,
            user: answers.username
        },
        body: {
            note: `webhint release script (${new Date()})`,
            scopes: ['repo']
        },
        headers: {
            'User-Agent': 'Nellie The Narwhal',
            'X-GitHub-OTP': answers.otp
        },
        json: true,
        method: 'POST',
        url: 'https://api.github.com/authorizations'
    });

    if (res.statusCode !== 201) {
        console.error(`\nError: ${res.body.message}\n`);
        await createGitHubToken(false);
    } else {
        GITHUB.password = answers.password;
        GITHUB.token = res.body.token;
        GITHUB.tokenID = res.body.id;
        GITHUB.userName = answers.username;
    }
};

const updateFile = (filePath: string, content: string) => {
    const writeContent = (shell as any)['ShellString']; // eslint-disable-line dot-notation

    writeContent(content).to(filePath);
};

const createRelease = async (tag?: string, releaseNotes?: string) => {
    const res = await request({
        body: {
            body: releaseNotes,
            name: tag,
            tag_name: tag // eslint-disable-line camelcase
        },
        headers: {
            Authorization: `token ${GITHUB.token}`,
            'User-Agent': 'Nellie The Narwhal'
        },
        json: true,
        method: 'POST',
        url: `https://api.github.com/repos/${REPOSITORY_SLUG}/releases`
    }) as req.Response;

    if (res.statusCode !== 201) {
        throw new Error(res.body.message);
    }
};

const downloadFile = async (downloadURL: string, downloadLocation: string) => {
    const res = await request({ url: downloadURL }) as req.Response;

    if (res.body.message) {
        throw new Error(res.body.message);
    }

    await updateFile(downloadLocation, res.body);

    await exec('git reset HEAD');
    await exec(`git add ${downloadLocation}`);

    if ((await exec(`git diff --cached "${downloadLocation}"`)).stdout) {
        await exec(`git commit -m "Update: \\\`${path.basename(downloadLocation)}\\\`"`);
    }
};

const extractDataFromCommit = async (sha: string): Promise<Commit> => {
    const commitBodyLines = (await exec(`git show --no-patch --format=%B ${sha}`)).stdout.split('\n');

    const associatedIssues: string[] = [];
    const title = commitBodyLines[0];
    const tag = title.split(':')[0];

    const regex = /(Fix|Close)\s+#([0-9]+)/gi;

    commitBodyLines.shift();
    commitBodyLines.forEach((line) => {
        const match = regex.exec(line);

        if (match) {
            associatedIssues.push(match[2]);
        }
    });

    return {
        associatedIssues,
        sha,
        tag,
        title
    };
};

const gitHasUncommittedChanges = async (): Promise<boolean> => {
    return (await exec('git status -s')).stdout !== '';
};

const gitCommitChanges = async (commitMessage: string, skipCI: boolean = false, files: string[] = ['packages', 'yarn.lock']) => {
    // Add all changes to the staging aread.
    await exec(`git add ${files.join(' ')}`);

    /*
     * If there aren't any changes in the staging area,
     * skip the following.
     */
    if (!await gitHasUncommittedChanges()) {

        return;
    }

    // Otherwise commit the changes.
    await exec(`git commit -m "${commitMessage}${skipCI ? ' ***NO_CI***' : ''}"`);
};

const gitCommitBuildChanges = async (ctx: TaskContext) => {
    await gitCommitChanges(`🚀 ${ctx.packageName} - v${ctx.newPackageVersion}`, true);
};

const gitCommitPrerelease = async () => {
    await gitCommitChanges(`🚀 Prerelease`, true);
};

const deleteGitHubToken = async () => {

    console.log('\nDelete GitHub token\n');

    const questions = [{
        message: 'GitHub OTP:',
        name: 'otp',
        type: 'input'
    }];

    const answers = await inquirer.prompt(questions) as inquirer.Answers;

    const res = await request({
        auth: {
            pass: GITHUB.password,
            user: GITHUB.userName
        },
        headers: {
            'User-Agent': 'Nellie The Narwhal',
            'X-GitHub-OTP': answers.otp
        },
        method: 'DELETE',
        url: `https://api.github.com/authorizations/${GITHUB.tokenID}`
    }) as req.Response;

    if (res.statusCode !== 204) {
        console.error(`Failed to delete GitHub Token: ${GITHUB.tokenID}`);
    }
};

const prettyPrintArray = (a: string[]): string => {
    return [a.slice(0, -1).join(', '), a.slice(-1)[0]].join(a.length < 2 ? '' : ', and ');
};

const getCommitAuthorInfo = async (commitSHA: string): Promise<object | null> => {
    let commitInfo;

    // Get commit related info.

    const responseForCommitInfoRequest = await request({
        headers: {
            Authorization: `token ${GITHUB.token}`,
            'User-Agent': 'Nellie The Narwhal'
        },
        method: 'GET',
        url: `https://api.github.com/repos/${REPOSITORY_SLUG}/commits/${commitSHA}`
    });

    if (responseForCommitInfoRequest.statusCode === 200) {
        try {
            commitInfo = JSON.parse(responseForCommitInfoRequest.body);
        } catch (e) {
            // Ignore as it's not important.
        }
    }

    if (!commitInfo) {
        return null;
    }

    /*
     * Get commit author related info.
     *
     * This is done because the previous request doesn't provide
     * the user name, only the user name associated with the commit,
     * which in most cases, is wrongly set.
     */

    const responseForUserInfoRequest = await request({
        headers: {
            Authorization: `token ${GITHUB.token}`,
            'User-Agent': 'Nellie The Narwhal'
        },
        method: 'GET',
        url: `https://api.github.com/users/${commitInfo.author.login}`
    });

    if (responseForUserInfoRequest.statusCode === 200) {
        try {
            const response = JSON.parse(responseForUserInfoRequest.body);

            if (response.name) {
                return {
                    gitHubProfileURL: response.html_url,
                    /*
                     * Get the user name, and if one is not provided,
                     * use the name associated with the commit.
                     */
                    name: response.name || commitInfo.commit.author.name
                };
            }
        } catch (e) {
            // Ignore as this is not important.
        }
    }

    return null;
};

const prettyPrintCommit = async (commit: Commit): Promise<string> => {

    let additionalInfo = false;
    let commitAuthorInfo = '';
    let issuesInfo = '';
    let result = `* [[\`${commit.sha.substring(0, 10)}\`](${REPOSITORY_URL}/commit/${commit.sha})] - ${commit.title}`;

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Get commit author information.

    const commitAuthor = await getCommitAuthorInfo(commit.sha);

    if (commitAuthor) {
        commitAuthorInfo = `by [\`${(commitAuthor as any).name}\`](${(commitAuthor as any).gitHubProfileURL})`;
        additionalInfo = true;
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Get related issues information.

    const issues = commit.associatedIssues.map((issue) => {
        return `[\`#${issue}\`](${REPOSITORY_URL}/issues/${issue})`;
    });

    if (issues.length > 0) {
        issuesInfo = `see also: ${prettyPrintArray(issues)}`;
        additionalInfo = true;
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    if (additionalInfo) {
        result = `${result} (${commitAuthorInfo}${commitAuthorInfo && issuesInfo ? ' / ': ''}${issuesInfo})`;
    }

    return `${result}.`;
};

const generateChangelogSection = async (title: string, tags: string[], commits: Commit[]): Promise<string> => {
    let result = '';

    for (const commit of commits) {
        if (tags.includes(commit.tag)) {
            result += `${await prettyPrintCommit(commit)}\n`;
        }
    }

    if (result !== '') {
        result = `## ${title}\n\n${result}`;
    }

    return result;
};

const getDate = (): string => {
    const date = new Date();
    const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December'
    ];

    return `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

const getChangelogContent = (ctx: TaskContext) => {
    return `# ${ctx.newPackageVersion} (${getDate()})\n\n${ctx.packageReleaseNotes}\n`;
};

const getChangelogData = async (commits: Commit[] = []): Promise<ChangelogData> => {

    /*
     * Note: Commits that use tags that do not denote user-facing
     * changes will not be included in changelog file, and the
     * release notes.
     */

    const breakingChanges = await generateChangelogSection('Breaking Changes', ['Breaking'], commits);
    const bugFixesAndImprovements = await generateChangelogSection('Bug fixes / Improvements', ['Docs', 'Fix'], commits);
    const newFeatures = await generateChangelogSection('New features', ['New', 'Update'], commits);

    let releaseNotes = '';

    releaseNotes += breakingChanges ? `${breakingChanges}\n` : '';
    releaseNotes += bugFixesAndImprovements ? `${bugFixesAndImprovements}\n` : '';
    releaseNotes += newFeatures ? `${newFeatures}\n` : '';

    // Determine semver version.

    let semverIncrement: SemverIncrement = 'patch';

    if (breakingChanges) {
        semverIncrement = 'major';
    } else if (newFeatures) {
        semverIncrement = 'minor';
    }

    return {
        releaseNotes,
        semverIncrement
    };
};

const getCommitsSinceLastRelease = async (packagePath?: string, lastRelease?: string): Promise<Commit[]> => {
    const commits: Commit[] = [];
    const commitSHAsSinceLastRelease = (await exec(`git rev-list master...${lastRelease} ${packagePath}`)).stdout;

    if (!commitSHAsSinceLastRelease) {
        return commits;
    }

    const shas = commitSHAsSinceLastRelease.split('\n');

    for (const sha of shas) {
        const data = await extractDataFromCommit(sha);

        commits.push(data);
    }

    return commits;
};

const getCommitSHAsSinceLastRelease = async (ctx: TaskContext) => {
    ctx.commitSHAsSinceLastRelease = await getCommitsSinceLastRelease(ctx.packagePath, ctx.packageLastTag);
};

const getLastReleasedVersionNumber = async (ctx: TaskContext) => {
    const packageJSONFileContent = (await exec(`git show ${ctx.packageLastTag}:${ctx.packageJSONFilePath}`)).stdout;

    ctx.packageVersion = (JSON.parse(packageJSONFileContent)).version;
};

const getVersionNumber = (ctx: TaskContext) => {
    ctx.newPackageVersion = ctx.packageJSONFileContent.version;
};

const shouldTriggerRelease = (commits: Commit[] = []): boolean => {

    /*
     * Some tags, even though they are user-facing will only trigger
     * a release if there are seen with other user-facing tags.
     *
     * (e.g.: `Docs`, see: https://github.com/webhintio/hint/issues/1510)
     */

    const tagsThatTriggerRelease = [
        'Breaking',
        'Fix',
        'New',
        'Update'
    ];

    for (const commit of commits) {
        if (tagsThatTriggerRelease.includes(commit.tag)) {
            return true;
        }
    }

    return false;
};

const getReleaseData = async (ctx: TaskContext) => {
    if (!ctx.isPrerelease &&
        !shouldTriggerRelease(ctx.commitSHAsSinceLastRelease)) {
        ctx.skipRemainingTasks = true;
    }

    ({
        semverIncrement: ctx.packageSemverIncrement,
        releaseNotes: ctx.packageReleaseNotes
    } = await getChangelogData(ctx.commitSHAsSinceLastRelease));
};

const getReleaseNotes = (changelogFilePath: string): string => {

    /*
     * The change log is structured as follows:
     *
     * # <version_number> (<date>)
     * <empty_line>
     * <version_log> <= this is what we need to extract
     * <empty_line>
     * <empty_line>
     * # <version_number> (<date>)
     * <empty_line>
     * <version_log>
     * ...
     */

    const eol = '\\r?\\n';
    const regex = new RegExp(`#.*${eol}${eol}([\\s\\S]*?)${eol}${eol}${eol}`);

    return regex.exec(shell.cat(changelogFilePath))![1];
};

const gitCreateRelease = async (ctx: TaskContext) => {
    if (!ctx.isUnpublishedPackage) {
        await createRelease(ctx.packageNewTag, getReleaseNotes(ctx.changelogFilePath));
    } else {
        await createRelease(ctx.packageNewTag, `${shell.cat(ctx.changelogFilePath)}`);
    }
};

const gitDeleteTag = async (tag: string) => {
    if ((await exec(`git tag --list "${tag}"`)).stdout) {
        await exec(`git tag -d ${tag}`);
    }
};

const gitFetchTags = async () => {
    await exec('git fetch --tags');
};

const gitGetCurrentBranch = async (): Promise<string> => {
    return (await exec(`git symbolic-ref --short HEAD`)).stdout;
};

const gitGetLastTaggedRelease = async (ctx: TaskContext) => {
    ctx.packageLastTag = (await exec(`git describe --tags --abbrev=0 --match "${ctx.packageName}-v*"`)).stdout;
};

const gitPush = async (ctx: TaskContext) => {
    await exec(`git push origin master ${ctx.packageNewTag ? ctx.packageNewTag : ''}`);
};

const gitReset = async () => {
    await exec(`git reset --quiet HEAD && git checkout --quiet .`);
};

const gitTagNewVersion = async (ctx: TaskContext) => {
    ctx.packageNewTag = `${ctx.packageName}-v${ctx.newPackageVersion}`;

    await gitDeleteTag(ctx.packageNewTag);
    await exec(`git tag -a "${ctx.packageNewTag}" -m "${ctx.packageNewTag}"`);
};

const newTask = (title: string, task: (ctx: TaskContext) => void, condition?: boolean) => {
    return {
        enabled: (ctx: TaskContext) => {
            return !ctx.skipRemainingTasks || condition;
        },
        task,
        title
    };
};

const npmInstall = async (ctx: TaskContext) => {
    await exec(`cd ${ctx.packagePath} && npm install`);
};

const npmPublish = (ctx: TaskContext) => {
    return listrInput('Enter OTP: ', {
        done: async (otp: string) => {
            if (!ctx.isPrerelease) {
                await exec(`cd ${ctx.packagePath} && npm publish ${ctx.isUnpublishedPackage ? '--access public' : ''} --otp=${otp}`);
            } else {
                await exec(`cd ${ctx.packagePath} && npm publish --otp=${otp} --tag next`);
            }
        }
    }).catch((err: any) => {
        if (err.stderr.indexOf('you already provided a one-time password then it is likely that you either typoed') !== -1) {
            return npmPublish(ctx);
        }

        ctx.npmPublishError = err;

        throw new Error(JSON.stringify(err));
    });
};

const npmRemovePrivateField = (ctx: TaskContext) => {
    delete ctx.packageJSONFileContent.private;
    updateFile(ctx.packageJSONFilePath!, `${JSON.stringify(ctx.packageJSONFileContent, null, 2)}\n`);
};

const npmRunBuildForRelease = async (ctx: TaskContext) => {
    await exec(`cd ${ctx.packagePath} && npm run build-release`);
};

const npmRunTests = async (ctx: TaskContext) => {
    await execWithRetry(`cd ${ctx.packagePath} && npm run test-release`);
};

const npmUpdateVersion = async (ctx: TaskContext) => {
    const version = (await exec(`cd ${ctx.packagePath} && npm --quiet version ${ctx.packageSemverIncrement} --no-git-tag-version`)).stdout;

    /*
     * `verstion` will be something such as `vX.X.X`,
     *  so the `v` will need to be removed.
     */
    ctx.newPackageVersion = version.substring(1, version.length);
};

const npmUpdateVersionForPrerelease = (ctx: TaskContext) => {
    const newPrereleaseVersion = semver.inc(ctx.packageJSONFileContent.version, (`pre${ctx.packageSemverIncrement}` as any), ('beta' as any))!;

    ctx.packageJSONFileContent.version = newPrereleaseVersion;
    ctx.newPackageVersion = newPrereleaseVersion;

    updateFile(`${ctx.packageJSONFilePath}`, `${JSON.stringify(ctx.packageJSONFileContent, null, 2)}\n`);
};

const releaseScriptCanBeRun = async (): Promise<boolean> => {

    // Check if on `master`.

    if (await gitGetCurrentBranch() !== 'master') {
        console.error('Release cannot be run as the branch is not `master`.');

        return false;
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Check if there are uncommited changes.

    if (await gitHasUncommittedChanges()) {
        console.error('Release cannot be run as there are uncommitted changes.');

        return false;
    }

    let remoteForMaster;

    try {
        remoteForMaster = (await exec(`git config --get branch.master.remote`)).stdout;
    } catch (e) {
        /*
         * If there is no remote the above will return
         * with a status code 1 so, ignore this block.
         */
    }

    // Check if no remote was found for `master`.

    if (!remoteForMaster) {
        console.error('Release cannot be run as no remote was found for `master`.');

        return false;
    }

    // Check if the remote for `master` is not set to the main repository.

    /*
     * The following regex checks if the remote URL is either:
     *
     *   * git@github.com:webhintio/hint.git
     *   * https://github.com/webhintio/hint.git
     */

    const remoteRegex = new RegExp('^(https://|git@)github.com[:/]webhintio/hint.git$', 'i');
    const remoteURLForMaster = (await exec(`git config --get remote.${remoteForMaster}.url`)).stdout;

    if (!remoteRegex.test(remoteURLForMaster)) {
        console.error('Release cannot be run as the remote for `master` does not point to the official webhint repository.');

        return false;
    }

    return true;
};

const updateChangelog = (ctx: TaskContext) => {
    if (!ctx.isUnpublishedPackage) {
        updateFile(ctx.changelogFilePath, `${getChangelogContent(ctx)}${shell.cat(ctx.changelogFilePath)}`);
    } else {
        ctx.packageReleaseNotes = '✨';
        updateFile(ctx.changelogFilePath, getChangelogContent(ctx));
    }
};

const updateConnectivityIni = async () => {
    await downloadFile(
        'https://raw.githubusercontent.com/WPO-Foundation/webpagetest/master/www/settings/connectivity.ini.sample',
        path.normalize('packages/hint-performance-budget/src/connections.ini')
    );
};

const updateSnykSnapshot = async () => {
    await downloadFile(
        'https://snyk.io/partners/api/v2/vulndb/clientside.json',
        path.normalize('packages/hint-no-vulnerable-javascript-libraries/src/snyk-snapshot.json')
    );
};

const updateTypeScriptSchema = async () => {
    await downloadFile(
        'http://json.schemastore.org/tsconfig',
        path.normalize('packages/parser-typescript-config/src/schema.json')
    );
};

const updateAmpValidator = async () => {
    await downloadFile(
        'https://cdn.ampproject.org/v0/validator.js',
        path.normalize('packages/hint-amp-validator/src/validator')
    );
};

const updatePackageVersionNumberInOtherPackages = async (ctx: TaskContext) => {
    /*
     * Types of dependencies that trigger breaking
     * changes in packages that depend on them.
     */

    const breakingDependencyTypes = [
        'dependencies'
    ];

    const dependencyTypes = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies'
    ];

    const packages = [...shell.ls('-d', `packages/!(${ctx.packageName})`)];
    const packagesThatRequireMajorRelease = [];

    const semverIncrement = semver.diff(ctx.packageVersion as string, ctx.newPackageVersion as string);
    const isBreakingChange = [
        'major',
        'premajor'
    ].includes(semverIncrement as string);

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    for (const pkg of packages) {

        const packageJSONFilePath = `${pkg}/package.json`;
        let packageJSONFileContent: any;

        /*
         * If the package doesn't have a valid `package.json` file,
         * skip to the next package.
         */

        try {
            packageJSONFileContent = require(`../../${packageJSONFilePath}`);
        } catch {
            continue;
        }

        const dependencyName = ctx.packageName === 'hint' ? ctx.packageName : `@hint/${ctx.packageName}`;
        let packageJSONFileHasBeenUpdated = false;

        for (const dependencyType of dependencyTypes) {
            const dependencyRange = packageJSONFileContent[dependencyType] && packageJSONFileContent[dependencyType][dependencyName];

            if (!dependencyRange) {
                continue;
            }

            packageJSONFileHasBeenUpdated = true;
            packageJSONFileContent[dependencyType][dependencyName] = `^${ctx.newPackageVersion}`;

            /*
             * In order to avoid release loops, only trigger
             * a breaking change if the package is dependent
             * upon one of the breaking dependency types.
             */

            if (isBreakingChange &&
                breakingDependencyTypes.includes(dependencyType)) {
                packagesThatRequireMajorRelease.push(pkg);
            }
        }

        if (packageJSONFileHasBeenUpdated) {
            updateFile(`${packageJSONFilePath}`, `${JSON.stringify(packageJSONFileContent, null, 2)}\n`);
        }
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Commit the changes, unless it's a prerelease.

    if (ctx.isPrerelease) {
        return;
    }

    // Commit changes separately depending on the type.

    if (breakingDependencyTypes.length !== 0) {
        await gitCommitChanges(`Breaking: Update '${ctx.packageName}' to 'v${ctx.newPackageVersion}'`, true, packagesThatRequireMajorRelease);
    }

    await gitCommitChanges(`Chore: Update '${ctx.packageName}' to 'v${ctx.newPackageVersion}'`, true);
};

const updateYarnLockFile = async () => {
    await exec('yarn');
    await gitCommitChanges(`Chore: Update 'yarn.lock' file`);
};

const waitForUser = async () => {
    return await listrInput('Press any key once you are done with the review:');
};

const getTasksForRelease = (packageName: string, packageJSONFileContent: any) => {

    const tasks: Task[] = [];

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Update package related files.

    if (packageName === 'hint-no-vulnerable-javascript-libraries') {
        tasks.push(newTask('Update `snyk-snapshot.json`', updateSnykSnapshot));
    }

    if (packageName === 'parser-typescript-config') {
        tasks.push(newTask('Update `schema.json`', updateTypeScriptSchema));
    }

    if (packageName === 'hint-performance-budget') {
        tasks.push(newTask('Update `connections.ini`', updateConnectivityIni));
    }

    if (packageName === 'hint-amp-validator') {
        tasks.push(newTask('Update `validator.js`', updateAmpValidator));
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Unpublished package tasks.

    if (packageJSONFileContent.private === true) {
        tasks.push(
            newTask('Get version number.', getVersionNumber),
            newTask('Remove `"private": true` from the `package.json` file.', npmRemovePrivateField),
            newTask('Update `CHANGELOG.md` file.', updateChangelog)
        );

        // Published package tasks.

    } else {
        tasks.push(
            newTask('Get last tagged release.', gitGetLastTaggedRelease),
            newTask('Get last released version number.', getLastReleasedVersionNumber),
            newTask('Get commits SHAs since last release.', getCommitSHAsSinceLastRelease),
            newTask('Get release notes and semver increment.', getReleaseData),
            newTask('Update version in `package.json`.', npmUpdateVersion),
            newTask('Update `CHANGELOG.md` file.', updateChangelog),
            newTask(`Review 'CHANGELOG.md'.`, waitForUser)
        );
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    // Common tasks for both published and unpublished packages.

    tasks.push(newTask('Install dependencies.', npmInstall));

    // `configurations` don't have tests or build step.

    if (!packageName.startsWith('configuration-')) {
        tasks.push(
            newTask('Run tests.', npmRunTests),
            newTask('Run release build.', npmRunBuildForRelease),
        );
    }

    tasks.push(
        newTask('Commit changes.', gitCommitBuildChanges),
        newTask('Tag new version.', gitTagNewVersion),
        newTask(`Publish on npm.`, npmPublish),
        newTask(`Push changes upstream.`, gitPush),
        newTask(`Create release.`, gitCreateRelease),

        /*
         * To keep things in sync, after a package is released,
         * update all other packages to use its newly released version.
         */

        newTask(`Update \`${packageName}\` version numbers in other packages.`, updatePackageVersionNumberInOtherPackages),
        newTask(`Push changes upstream.`, gitPush)
    );

    return tasks;
};

const getTaksForPrerelease = (packageName: string) => {

    const tasks = [];

    tasks.push(
        newTask('Get last tagged release.', gitGetLastTaggedRelease),
        newTask('Get commits SHAs since last release.', getCommitSHAsSinceLastRelease),
        newTask('Get semver increment.', getReleaseData),
        newTask('Update version in `package.json`.', npmUpdateVersionForPrerelease),
        newTask('Install dependencies.', npmInstall)
    );

    // `configurations` don't have tests or build step.

    if (!packageName.startsWith('configuration-')) {
        tasks.push(
            newTask('Run tests.', npmRunTests),
            newTask('Run release build.', npmRunBuildForRelease)
        );
    }

    tasks.push(
        newTask(`Publish on npm.`, npmPublish),
        newTask(`Update \`${packageName}\` version number in other packages.`, updatePackageVersionNumberInOtherPackages)
    );

    return tasks;
};

const getTasks = (packagePath: string) => {

    const packageName = packagePath.substring(packagePath.lastIndexOf('/') + 1);
    const packageJSONFileContent = require(`../../${packagePath}/package.json`);
    const isUnpublishedPackage = packageJSONFileContent.private === true;
    const isPrerelease = !!argv.prerelease;

    const tasks: Task[] = [];

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    tasks.push({
        task: (ctx) => {
            ctx.skipRemainingTasks = false;

            ctx.packagePath = packagePath;
            ctx.packageName = ctx.packagePath.substring(ctx.packagePath.lastIndexOf('/') + 1);

            ctx.changelogFilePath = `${ctx.packagePath}/CHANGELOG.md`;
            ctx.packageJSONFilePath = `${ctx.packagePath}/package.json`;
            ctx.packageLockJSONFilePath = `${ctx.packagePath}/package-lock.json`;

            ctx.packageJSONFileContent = packageJSONFileContent;

            ctx.isUnpublishedPackage = isUnpublishedPackage;
            ctx.isPrerelease = isPrerelease;
        },
        title: `Get package information.`
    });

    if (!isPrerelease) {
        tasks.push(...getTasksForRelease(packageName, packageJSONFileContent));

        // For prereleases, ignore packages that have not yet been released.

    } else if (!isUnpublishedPackage) {
        tasks.push(...getTaksForPrerelease(packageName));
    }

    tasks.push(newTask(`Cleanup.`, cleanup));

    return new Listr(tasks);
};

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const main = async () => {

    if (!await releaseScriptCanBeRun()) {
        return;
    }

    const isPrerelease = argv.prerelease;

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    await gitFetchTags();

    /*
     * For prereleases the release logs are not published,
     * so there is no need to create a GitHub token.
     */

    if (!isPrerelease) {
        await createGitHubToken();
    }

    /*
     * Note: The order of the followings matters as some
     * packages depend on previous ones to be released first.
     */

    const exceptions: string[] = [];

    if (process.platform !== 'win32') {
        exceptions.push('packages/connector-edge');
    }

    const packages = [
        'packages/hint',
        ...shell.ls('-d', 'packages/create-*'),
        ...shell.ls('-d', 'packages/utils-create-server'),
        ...shell.ls('-d', 'packages/utils-connector-tools'),
        ...shell.ls('-d', 'packages/utils-debugging-protocol-common'),
        ...shell.ls('-d', 'packages/parser-html'),
        ...shell.ls('-d', 'packages/connector-*'),
        ...shell.ls('-d', 'packages/utils-tests-helpers'),
        ...shell.ls('-d', 'packages/formatter-*'),
        ...shell.ls('-d', 'packages/parser-!(html)'),
        ...shell.ls('-d', 'packages/hint-*'),
        ...shell.ls('-d', 'packages/configuration-!(development)'),
        'packages/configuration-development'
    ].filter((name) => {
        return !exceptions.includes(name);
    });

    const tasks: Task[][] = [];

    for (const pkg of packages) {
        tasks.push([{
            task: () => {
                return getTasks(pkg);
            },
            title: `${pkg}`
        }]);
    }

    /*
     * For prereleases no commits or tags
     * are done, just this one at the end.
     */

    if (isPrerelease) {
        tasks.push(
            [newTask('Commit changes.', gitCommitPrerelease)],
            [newTask(`Push changes upstream.`, gitPush)]
        );
    }

    tasks.push([newTask('Update `yarn.lock`', updateYarnLockFile)]);

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    for (const task of tasks) {
        const skipRemainingTasks = await new Listr(task)
            .run()
            .catch(async (err: any) => {
                console.error(typeof err === 'object' ? JSON.stringify(err, null, 4) : err);

                await gitReset();
                await gitDeleteTag(err.context.packageNewTag);
                await removePackageFiles();

                return true;
            });

        if (skipRemainingTasks === true) {
            break;
        }
    }

    if (!isPrerelease) {
        await deleteGitHubToken();
    }
};

main();
