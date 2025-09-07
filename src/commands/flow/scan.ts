import { SfCommand, Flags } from "@salesforce/sf-plugins-core";
import { Messages, SfError } from "@salesforce/core";
import chalk from "chalk";
import { exec } from "child_process";

import { loadScannerOptions } from "../../libs/ScannerConfig.js";
import { FindFlows } from "../../libs/FindFlows.js";
import { ScanResult as Output } from "../../models/ScanResult.js";

import pkg, {
  ParsedFlow,
  ScanResult,
  RuleResult,
  ResultDetails,
} from "@corekraft/flow-linter-core";
import { inspect } from "util";
const { parse: parseFlows, scan: scanFlows } = pkg;

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);

const messages = Messages.loadMessages("@corekraft/flow-linter", "command");

export default class Scan extends SfCommand<Output> {
  public static description = messages.getMessage("commandDescription");
  public static examples: string[] = [
    "sf flow lint",
    "sf flow lint --failon warning",
    "sf flow lint -c path/to/config.json",
    "sf flow lint -c path/to/config.json --json",
    "sf flow lint -c path/to/config.json --failon warning",
    "sf flow lint -d path/to/flows/directory",
    "sf flow lint --files path/to/single/file.flow-meta.xml path/to/another/file.flow-meta.xml",
    "sf flow lint -p path/to/single/file.flow-meta.xml path/to/another/file.flow-meta.xml",
  ];
  public static aliases: string[] = ["flow lint"];

  protected static requiresUsername = false;
  protected static supportsDevhubUsername = false;
  public static requiresProject = false;
  protected static supportsUsername = true;

  protected userConfig: object;
  protected failOn = "error";
  protected errorCounters: Map<string, number> = new Map<string, number>();

  public static readonly flags = {
    directory: Flags.directory({
      char: "d",
      description: messages.getMessage("directoryToScan"),
      required: false,
      exists: true,
      exclusive: ["files"],
    }),
    config: Flags.file({
      char: "c",
      description: "Path to configuration file",
      required: false,
    }),
    failon: Flags.option({
      char: "f",
      description:
        "Threshold failure level (error, warning, note, or never) defining when the command return code will be 1",
      options: ["error", "warning", "note", "never"] as const,
      default: "error",
    })(),
    retrieve: Flags.boolean({
      char: "r",
      description: "Force retrieve Flows from org at the start of the command",
      default: false,
    }),
    files: Flags.file({
      multiple: true,
      exists: true,
      description: "List of source flows paths to scan",
      charAliases: ["p"],
      exclusive: ["directory"],
    }),
    targetusername: Flags.string({
      char: "u",
      description:
        "Retrieve the latest metadata from the target before the scan.",
      required: false,
      charAliases: ["o"],
    }),
  };

  public async run(): Promise<Output> {
    const { flags } = await this.parse(Scan);
    this.failOn = flags.failon || "error";
    this.spinner.start("Loading Flow Linter");
    this.userConfig = await loadScannerOptions(flags.config);
    if (flags.targetusername) {
      await this.retrieveFlowsFromOrg(flags.targetusername);
    }

    const targets: string[] = flags.files;

    const flowFiles = this.findFlows(flags.directory, targets);
    this.spinner.start(`Identified ${flowFiles.length} flows to scan`);
    // to
    // core.Flow
    const parsedFlows: ParsedFlow[] = await parseFlows(flowFiles);
    this.debug(`parsed flows ${parsedFlows.length}`, ...parsedFlows);

    this.enforceSecurityGuards();
    const tryScan = (): [ScanResult[], error: Error] => {
      try {
        const scanResult =
          this.userConfig && Object.keys(this.userConfig).length > 0
            ? scanFlows(parsedFlows, this.userConfig)
            : scanFlows(parsedFlows);
        return [scanResult, null];
      } catch (error) {
        return [null, error];
      }
    };

    const [scanResults, error] = tryScan();
    this.debug(`use new scan? ${process.env.IS_NEW_SCAN_ENABLED}`);
    this.debug(`error:`, inspect(error));
    this.debug(`scan results: ${scanResults.length}`, ...scanResults);
    this.spinner.stop(`Scan complete`);

    // Build results
    const results = this.buildResults(scanResults);

    if (results.length > 0) {
      const resultsByFlow = {};
      for (const result of results) {
        resultsByFlow[result.flowName] = resultsByFlow[result.flowName] || [];
        resultsByFlow[result.flowName].push(result);
      }
      for (const resultKey in resultsByFlow) {
        const matchingScanResult = scanResults.find((res) => {
          return res.flow.label === resultKey;
        });
        this.styledHeader(
          "Flow: " +
            chalk.yellow(resultKey) +
            " " +
            chalk.bgYellow(`(${matchingScanResult.flow.name}.flow-meta.xml)`) +
            " " +
            chalk.red("(" + resultsByFlow[resultKey].length + " results)"),
        );
        this.log(chalk.italic("Type: " + matchingScanResult.flow.type));
        this.log("");
        // todo flow uri
        //this.table(resultsByFlow[resultKey], ['rule', 'type', 'name', 'severity']);
        this.table({
          data: resultsByFlow[resultKey],
          columns: ["rule", "type", "name", "severity"],
        });
        this.debug(`Results By Flow: 
          ${inspect(resultsByFlow[resultKey])}`);
        this.log("");
      }
    }
    this.styledHeader(
      "Total: " +
        chalk.red(results.length + " Results") +
        " in " +
        chalk.yellow(scanResults.length + " Flows") +
        ".",
    );

    // Display number of errors by severity
    for (const severity of ["error", "warning", "note"]) {
      const severityCounter = this.errorCounters[severity] || 0;
      this.log(`- ${severity}: ${severityCounter}`);
    }

    // TODO CALL TO ACTION
    this.log("");
    this.log(
      chalk.bold(
        chalk.italic(
          chalk.yellowBright(
            "Be a part of our mission to champion Flow Best Practices by starring ⭐ us on GitHub:",
          ),
        ),
      ),
    );
    this.log(
      chalk.italic(
        chalk.blueBright(
          chalk.underline("https://github.com/corekraft/flow-linter-sfcli"),
        ),
      ),
    );

    const status = this.getStatus();
    // Set status code = 1 if there are errors, that will make cli exit with code 1 when not in --json mode
    if (status > 0) {
      process.exitCode = status;
    }
    const summary = {
      flowsNumber: scanResults.length,
      results: results.length,
      message:
        "A total of " +
        results.length +
        " results have been found in " +
        scanResults.length +
        " flows.",
      errorLevelsDetails: {},
    };
    return { summary, status: status, results };
  }

  private findFlows(directory: string, sourcepath: string[]) {
    // List flows that will be scanned
    let flowFiles;
    if (directory) {
      flowFiles = FindFlows(directory);
    } else if (sourcepath) {
      flowFiles = sourcepath;
    } else {
      flowFiles = FindFlows(".");
    }
    return flowFiles;
  }

  private getStatus() {
    let status = 0;
    if (this.failOn === "never") {
      status = 0;
    } else {
      if (this.failOn === "error" && this.errorCounters["error"] > 0) {
        status = 1;
      } else if (
        this.failOn === "warning" &&
        (this.errorCounters["error"] > 0 || this.errorCounters["warning"] > 0)
      ) {
        status = 1;
      } else if (
        this.failOn === "note" &&
        (this.errorCounters["error"] > 0 ||
          this.errorCounters["warning"] > 0 ||
          this.errorCounters["note"] > 0)
      ) {
        status = 1;
      }
    }
    return status;
  }

    private enforceSecurityGuards(): void {
    // 🔒 Monkey-patch Function constructor
    (globalThis as any).Function = function (): never {
      throw new Error("Blocked use of Function constructor in lightning-flow-scanner-core");
    };

    // 🔒 Intercept dynamic import() calls
    const dynamicImport = (globalThis as any).import;
    (globalThis as any).import = async (...args: any[]): Promise<any> => {
      const specifier = args[0];
      if (typeof specifier === "string" && specifier.startsWith("http")) {
        throw new Error(`Blocked remote import: ${specifier}`);
      }
      return dynamicImport(...args);
    };
  }

  private buildResults(scanResults) {
    const errors = [];
    for (const scanResult of scanResults) {
      const flowName = scanResult.flow.label;
      const flowType = scanResult.flow.type[0];
      for (const ruleResult of scanResult.ruleResults as RuleResult[]) {
        const ruleDescription = ruleResult.ruleDefinition.description;
        const rule = ruleResult.ruleDefinition.label;
        if (
          ruleResult.occurs &&
          ruleResult.details &&
          ruleResult.details.length > 0
        ) {
          const severity = ruleResult.severity || "error";
          const flowUri = scanResult.flow.fsPath;
          const flowApiName = `${scanResult.flow.name}.flow-meta.xml`;
          for (const result of ruleResult.details as ResultDetails[]) {
            const detailObj = Object.assign(result, {
              ruleDescription,
              rule,
              flowName,
              flowType,
              severity,
              flowUri,
              flowApiName,
            });
            errors.push(detailObj);
            this.errorCounters[severity] =
              (this.errorCounters[severity] || 0) + 1;
          }
        }
      }
    }
    return errors;
  }

  private async retrieveFlowsFromOrg(targetusername: string) {
    let errored = false;
    this.spinner.start(chalk.yellowBright("Retrieving Metadata..."));
    const retrieveCommand = `sf project retrieve start -m Flow -o "${targetusername}"`;
    try {
      await exec(retrieveCommand, { maxBuffer: 1000000 * 1024 });
    } catch (exception) {
      errored = true;
      this.toErrorJson(exception);
      this.spinner.stop(chalk.redBright("Retrieve Operation Failed."));
    }
    if (errored) {
      throw new SfError(
        messages.getMessage("errorRetrievingMetadata"),
        "",
        [],
        1,
      );
    } else {
      this.spinner.stop(chalk.greenBright("Retrieve Completed ✔."));
    }
  }
}
