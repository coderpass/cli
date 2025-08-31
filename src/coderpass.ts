#!/usr/bin/env node

import { Command } from 'commander';
import simpleGit, { SimpleGit } from 'simple-git';
import chalk from 'chalk';
import { createSpinner } from 'nanospinner';

const program = new Command();

const LOGSTREAM_URL = 'https://api.coderpass.io/api/test/logstream'

program
    .name('coderpass')
    .description('CLI for coderpass')
    .version('1.0.0')

// Submit command - push to repository and stream logs
program
    .command('submit')
    .description('Submit code and run tests in CI')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (options) => {
        console.log('Submitting code to repository and streaming logs...');
        try {
            await submit({
                ...options,
                emptyCommit: true,
                message: 'Auto-submit from CLI'
            });
        } catch (error) {
            console.error('Error:', error);
            process.exit(1);
        }
    });

program.parse(process.argv);

async function getGit() {
    const cwd = process.cwd();
    console.log(`Working in directory: ${cwd}`);

    // Initialize git in the current directory
    const git: SimpleGit = simpleGit(cwd);

    // Check if we're in a git repository
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
        console.error('Error: Not a git repository');
        process.exit(1);
    }
    return git;
}

const streamLogs = async (commitHash: string) => {
    let jobResult = null;
    const response = await fetch(`${LOGSTREAM_URL}/${commitHash}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/event-stream'
        },
    })
    const reader = response?.body?.pipeThrough(new TextDecoderStream()).getReader()

    let currentStep: string | null = null;
    let testRan = false;
    let allMessages = [];
    let spinner = null;
    let seenStepsIDs = new Set();

    while (reader) {
        const { value, done } = await reader.read();
        if (done) break;


        allMessages.push(value);

        let json = {} as any;
        try {
            json = JSON.parse(value ?? '{}');
            if (typeof json === 'string') {
                json = JSON.parse(json);
            }
        } catch (error) {
            continue;
        }

        currentStep = json['step'] ?? currentStep;
        const currentMessage = json['message'] ?? null;
        const rawOutput = json['raw_output'] ?? null;
        const stepID = (json['stepID'] ?? [])[0] ?? null;

        // Server init sends only one message,
        if (currentStep === 'server_init') {
            spinner = createSpinner(currentMessage, { color: 'green' }).start()
            currentStep = null;
        }

        if (currentStep && !seenStepsIDs.has(stepID)) {
            seenStepsIDs.add(stepID);
            spinner?.success();
            spinner = createSpinner(`${currentStep}`, { color: 'yellow' }).start();
        }

        if (currentStep === 'Run tests' && rawOutput) {
            spinner?.success()
            spinner = null;
            process.stdout.write(currentMessage);
            testRan = true;
        }
    }

    if (!testRan) {
        spinner?.error()
        console.log(chalk.red("No tests ran, something went wrong, please contact admin@coderpass.io"))
    } else {
        spinner?.success()
    }
    spinner?.stop().clear()

    // Full verbose logs
    // for (const message of allMessages) {
    //     console.log(message)
    // }

    return jobResult;
}

async function submit(options: any) {
    try {
        const git = await getGit();

        if (options.verbose) {
            console.log('Detected git repository');
        }

        // Get current branch if not specified
        let branch = options.branch;
        if (!branch) {
            const status = await git.status();
            branch = status.current;

            // Handle detached HEAD state or invalid branch names
            if (branch === 'HEAD' || !branch) {
                // If in detached HEAD state, use a default branch name
                branch = 'main';
                console.log(`Detected detached HEAD state. Using default branch name: ${branch}`);
            } else {
                console.error(`Debug: Current branch: ${branch}`);
            }
        }

        const status = await git.status();

        // Check if there are changes to commit
        const hasChanges = status.files.length > 0;

        if (hasChanges) {
            // Add all changes in the entire repository, not just current directory
            await git.add('-A');
            // Commit with the provided message
            await git.commit(options.message || 'Auto-submit from CLI');
        } else {
            // No changes detected, make an empty commit if enabled
            if (options.emptyCommit !== false) {
                // Use raw git command to create an empty commit
                await git.raw(['commit', '--allow-empty', '-m', options.message || 'Auto-submit from CLI']);
            }
        }

        const commitHash = await git.revparse(['HEAD']);

        // Get the remote
        const remote = 'origin'

        // Force push to the remote with a fully qualified reference
        // Use fully qualified reference name to avoid Git errors
        const pushResult = await git.push(remote, `HEAD:refs/heads/${branch}`, ['--force']);

        if (options.verbose && pushResult) {
            console.log(pushResult);
        }

        console.log(`Connecting to log stream for commit ${commitHash}...`);

        await streamLogs(commitHash)
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }
}
