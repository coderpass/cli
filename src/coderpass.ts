#!/usr/bin/env node

import { Command } from "commander";
import simpleGit, { SimpleGit } from "simple-git";
import chalk from "chalk";
import { createSpinner } from "nanospinner";
import { hasCiWorkflow, hasWorkflowChanges } from "./utils";

const program = new Command();

const LOGSTREAM_URL = "https://api.coderpass.io/api/test/logstream";

program.name("coderpass").description("CLI for coderpass").version("1.0.0");

const GENERIC_ERROR_MESSAGE =
  chalk.red.bold("❌ Error: ") +
  "Something went wrong. Please try again.\n" +
  chalk.gray(
    "Contact us at https://practice.coderpass.io/contact if the issue persists."
  );

const NOT_A_CODERPASS_REPOSITORY_ERROR_MESSAGE =
  chalk.red.bold("❌ Error: ") +
  "CoderPass CLI should be run inside a cloned CoderPass challenge repository.\n\n" +
  chalk.yellow(
    "• Ensure you are in a cloned challenge repository and try again.\n"
  ) +
  chalk.yellow("• Or go to ") +
  chalk.cyan.underline("https://practice.coderpass.io/challenges") +
  chalk.yellow(" to start a new challenge.");

// Submit command - push to repository and stream logs
program
  .command("submit")
  .description("Submit code and run tests in CI")
  .action(async (options) => {
    const submitMsg = `${chalk.cyan.bold(
      "\n🚀 Submitting code to CoderPass...\n"
    )}
${chalk.gray("Streaming logs and running tests in CI.")}`;
    console.log(submitMsg);
    try {
      await submit({
        ...options,
        emptyCommit: true,
        message: "Auto-submit from CLI",
      });
    } catch (error) {
      console.error("\n" + GENERIC_ERROR_MESSAGE);
      if (error instanceof Error) {
        console.error(chalk.gray(`\nDetails: ${error.message}`));
      }
      process.exit(1);
    }
  });

program.parse(process.argv);

async function getGit() {
  // Initialize git in the current directory
  const git: SimpleGit = simpleGit(process.cwd());

  // Check if we're in a git repository
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.error("\n" + NOT_A_CODERPASS_REPOSITORY_ERROR_MESSAGE + "\n");
    process.exit(1);
  }

  // Check that the remote is pointing to git.coderpass.io
  const remotes = await git.getRemotes(true);
  const originRemote = remotes.find((r) => r.name === "origin");
  const remoteUrl = originRemote?.refs?.push || originRemote?.refs?.fetch;

  if (!remoteUrl?.includes("git.coderpass.io")) {
    console.error("\n" + NOT_A_CODERPASS_REPOSITORY_ERROR_MESSAGE + "\n");
    process.exit(1);
  }

  return git;
}

const streamLogs = async (commitHash: string) => {
  console.log();
  const short = commitHash.substring(0, 7);
  const connectSpinner = createSpinner(
    `Connecting to test logs stream for commit ${short}...`
  ).start();
  let jobResult = null;
  const response = await fetch(`${LOGSTREAM_URL}/${commitHash}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
  const reader = response?.body
    ?.pipeThrough(new TextDecoderStream())
    .getReader();

  if (reader) {
    connectSpinner.stop();
  } else {
    connectSpinner.error();
    return jobResult;
  }

  let currentStep: string | null = null;
  let testRan = false;
  let allMessages = [];
  let spinner = null;
  let seenStepsIDs = new Set();
  let seenCheckoutRepositoryStep = false;

  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;

    allMessages.push(value);

    let json = {} as any;
    try {
      json = JSON.parse(value ?? "{}");
      if (typeof json === "string") {
        json = JSON.parse(json);
      }
    } catch (error) {
      continue;
    }

    currentStep = json["step"] ?? currentStep;
    const currentMessage = json["message"] ?? null;
    const rawOutput = json["raw_output"] ?? null;
    const stepID = (json["stepID"] ?? [])[0] ?? null;

    // Server init sends only one message,
    if (currentStep === "server_init") {
      spinner = createSpinner(currentMessage, { color: "green" }).start();
      currentStep = null;
    }

    // This step is happening twice, once at the beginning and once at the end.
    // We only want to show it once.
    if (currentStep === "Checkout repository") {
      if (seenCheckoutRepositoryStep) {
        currentStep = "Finishing";
      }
      seenCheckoutRepositoryStep = true;
    }

    if (currentStep && !seenStepsIDs.has(stepID)) {
      seenStepsIDs.add(stepID);
      spinner?.success();
      spinner = createSpinner(`${currentStep}`, { color: "yellow" }).start();
    }

    if (currentStep === "Run tests" && rawOutput) {
      spinner?.success();
      spinner = null;
      process.stdout.write(currentMessage);
      testRan = true;
    }
  }

  if (!testRan) {
    spinner?.error();
    console.log("\n" + GENERIC_ERROR_MESSAGE);
  } else {
    spinner?.success();
  }
  spinner?.stop().clear();

  return jobResult;
};

async function submit(options: any) {
  try {
    const git = await getGit();

    // Block if workflow files are being changed in this working tree
    if (await hasWorkflowChanges(git)) {
      console.error(
        chalk.red.bold("\n❌ Submission blocked: ") +
          chalk.red("Changes to CI workflow files are not allowed.\n") +
          chalk.yellow("Please revert edits in ") +
          chalk.cyan(".github/workflows") +
          chalk.yellow(" and try again.\n")
      );
      return;
    }

    // Get current branch if not specified
    let branch = options.branch;
    if (!branch) {
      const status = await git.status();
      branch = status.current;

      // Handle detached HEAD state or invalid branch names
      if (branch === "HEAD" || !branch) {
        // If in detached HEAD state, use a default branch name
        branch = "main";
        console.log(
          chalk.yellow(`⚠️  Detected detached HEAD state. Using branch: `) +
            chalk.cyan.bold(branch)
        );
      } else {
        console.log(chalk.gray(`Branch: `) + chalk.cyan.bold(branch));
      }
    }

    const status = await git.status();

    // Check if there are changes to commit
    const hasChanges = status.files.length > 0;

    if (hasChanges) {
      // Add all changes in the entire repository, not just current directory
      await git.add("-A");
      // Commit with the provided message
      await git.commit(options.message || "Auto-submit from CLI");
    } else {
      // No changes detected, make an empty commit if enabled
      if (options.emptyCommit !== false) {
        // Use raw git command to create an empty commit
        await git.raw([
          "commit",
          "--allow-empty",
          "-m",
          options.message || "Auto-submit from CLI",
        ]);
      }
    }

    const commitHash = await git.revparse(["HEAD"]);

    // Force push to the remote with a fully qualified reference
    // Use fully qualified reference name to avoid Git errors
    await git.push("origin", `HEAD:refs/heads/${branch}`, ["--force"]);

    const ciWorkflowExists = await hasCiWorkflow(git);
    if (!ciWorkflowExists) {
      console.log(
        chalk.green.bold("\n✅ Code submitted successfully!\n\n") +
          chalk.yellow(
            "ℹ️  This challenge does not have a CI workflow configured.\n"
          ) +
          chalk.yellow("   No tests will be run in CI.\n\n") +
          chalk.gray("   See ") +
          chalk.cyan.bold("README.md") +
          chalk.gray(" on how to run and test your code locally.\n")
      );
      return;
    }

    await streamLogs(commitHash);
  } catch (error) {
    console.error("\n" + GENERIC_ERROR_MESSAGE);
    if (error instanceof Error) {
      console.error(chalk.gray(`\nDetails: ${error.message}`));
    }
    throw error;
  }
}
