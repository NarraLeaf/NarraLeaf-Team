/**
 * Putting Team's certificate authority into a machine's trust store, and taking
 * it out again.
 *
 * This is the one step of the whole arrangement that a person has to do
 * deliberately, and it cannot be automated away: a Studio installation's client
 * library builds a chain against the host's own trust store and offers no place
 * to pin a certificate. It does read `SSL_CERT_FILE`, on every platform — that
 * is how Team's own reader and the loreserver it supervises trust this server's
 * authority — but that variable belongs to whoever starts the process, and on a
 * collaborator's machine that is Studio rather than Team. So the decision to
 * trust this Team server is made once, by somebody who has compared a fingerprint
 * against one printed on the server.
 *
 * Trusting a certificate authority is not a small permission: anything holding
 * its private key can issue a certificate for any name, and this machine will
 * believe it. That is why nothing here runs as a side effect of starting a
 * server, why the fingerprint is printed before anything is installed, and why
 * the current user's store is used rather than the machine's — the blast radius
 * of a mistake is then one account rather than every account on the computer.
 *
 * Each platform is different in kind, not only in spelling:
 *
 *   - Windows has a per-user `Root` store, and `certutil` writes to it. The
 *     operating system raises its own confirmation dialog.
 *   - macOS has the login keychain, and `security` writes to it, asking for the
 *     account's password in a window of its own.
 *   - Linux has no per-user store that the TLS stacks of other programs read.
 *     What exists is a machine-wide directory needing root, so nothing is run:
 *     the two commands are printed for a person to run themselves.
 */
import { spawn } from "node:child_process";
import type { X509Certificate } from "node:crypto";

/** What a platform can be told to do about a certificate. */
export type TrustSupport = "runs-here" | "print-only";

/** How one platform is asked to trust or forget a certificate. */
export interface TrustPlan {
  /** Whether Team can carry this out, or can only say what to run. */
  readonly support: TrustSupport;
  /** The command, as a person would type it. */
  readonly command: string;
  /** The program and its arguments, for the platforms Team runs the command on. */
  readonly argv: readonly string[];
  /**
   * What the operating system will do on its own once this is started.
   *
   * Printed before the command runs, because a confirmation dialog behind
   * another window looks exactly like a program that has hung.
   */
  readonly interaction: string | undefined;
}

/** A file name for the certificate wherever it has to be copied to. */
const LINUX_FILE_NAME = "narraleaf-team.crt";

/**
 * The platform to answer for, defaulting to the one this is running on.
 *
 * A parameter rather than a read of `process.platform` inside each branch, for
 * one reason: two of the three answers below could not otherwise be checked by
 * anything. A Windows workstation exercises the win32 branch and nothing else,
 * CI runs on Linux and exercises the default branch and nothing else, and the
 * macOS commands — which are the ones a person is asked to trust with their
 * account password — were checked by no automated run anywhere. The same shape
 * `instanceLayout` uses for the loreserver version it installs under.
 */
export type TrustPlatform = NodeJS.Platform;

/**
 * Quote a path for the shell a person will paste this into.
 *
 * Windows paths hold spaces and backslashes; a POSIX shell needs single quotes
 * and Windows' own command line needs double ones.
 */
function quote(path: string, platform: TrustPlatform): string {
  if (platform === "win32") {
    return path.includes(" ") ? `"${path}"` : path;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** How this platform installs a certificate authority for the current user. */
export function installPlan(
  caCertPath: string,
  platform: TrustPlatform = process.platform,
): TrustPlan {
  switch (platform) {
    case "win32":
      // -user is the whole of the difference between this and an installation
      // every account on the machine inherits. `Root` is the store a chain is
      // built to; putting it anywhere else installs a certificate that is
      // trusted for nothing.
      return {
        support: "runs-here",
        command: `certutil -user -addstore Root ${quote(caCertPath, platform)}`,
        argv: ["certutil", "-user", "-addstore", "Root", caCertPath],
        // Measured on Windows 11: adding to the current user's Root store goes
        // through without a dialog. Whether it does is a matter of policy, so
        // the possibility is still mentioned — a modal window that opened
        // behind this one is indistinguishable from a program that has hung.
        interaction:
          "Windows may ask you to confirm installing a root certificate, in a dialog of " +
          "its own. If this seems to have stopped, look for a window behind this one.",
      };
    case "darwin":
      // Without -d this is the login keychain, which is the current user's.
      // `-r trustRoot` is what makes it a trusted root rather than a
      // certificate the system merely holds a copy of.
      return {
        support: "runs-here",
        command: `security add-trusted-cert -r trustRoot ${quote(caCertPath, platform)}`,
        argv: ["security", "add-trusted-cert", "-r", "trustRoot", caCertPath],
        interaction:
          "macOS will ask for your account password, in a window of its own. " +
          "It may open behind this one.",
      };
    default:
      // Linux and anything else. There is a per-user NSS database that Firefox
      // and Chrome read, and it is not what other programs use; a certificate
      // installed there would be trusted by browsers and by nothing else. The
      // machine-wide directory is the one that works, and it needs root.
      return {
        support: "print-only",
        command:
          `sudo cp ${quote(caCertPath, platform)} /usr/local/share/ca-certificates/${LINUX_FILE_NAME}\n` +
          "  sudo update-ca-certificates",
        argv: [],
        interaction: undefined,
      };
  }
}

/** How this platform takes the same certificate authority out again. */
export function removePlan(
  caCertPath: string,
  certificate: X509Certificate,
  platform: TrustPlatform = process.platform,
): TrustPlan {
  switch (platform) {
    case "win32": {
      // certutil identifies a certificate to delete by its SHA-1 thumbprint,
      // written without separators. The subject would also be accepted and is
      // not used: two Team servers on one machine have the same subject, and deleting
      // by name would take out whichever it found.
      const thumbprint = certificate.fingerprint.replaceAll(":", "");
      return {
        support: "runs-here",
        command: `certutil -user -delstore Root ${thumbprint}`,
        argv: ["certutil", "-user", "-delstore", "Root", thumbprint],
        // Measured, and the opposite way round from what one would guess:
        // adding to the Root store is silent and *removing* raises a
        // confirmation dialog. Windows guards the removal wherever it is asked
        // for — `certutil -f` does not suppress it, and neither does the
        // X509Store API. Without this warning the command sits there having
        // printed the certificate it is about to delete, apparently stuck.
        interaction:
          "Windows will ask you to confirm removing a root certificate, in a dialog of its " +
          "own. It may open behind this window, and nothing happens until you answer it.",
      };
    }
    case "darwin":
      return {
        support: "runs-here",
        command: `security remove-trusted-cert ${quote(caCertPath, platform)}`,
        argv: ["security", "remove-trusted-cert", caCertPath],
        interaction:
          "macOS will ask for your account password, in a window of its own. " +
          "It may open behind this one.",
      };
    default:
      return {
        support: "print-only",
        command:
          `sudo rm /usr/local/share/ca-certificates/${LINUX_FILE_NAME}\n` +
          "  sudo update-ca-certificates --fresh",
        argv: [],
        interaction: undefined,
      };
  }
}

/**
 * The command to install, on one line, for a message that mentions it in
 * passing.
 */
export function trustCommandFor(
  caCertPath: string,
  platform: TrustPlatform = process.platform,
): string {
  const plan = installPlan(caCertPath, platform);
  return plan.support === "runs-here"
    ? plan.command
    : `nlteam trust --install (it will print what to run)`;
}

/** What running a command came to. */
export interface CommandOutcome {
  readonly code: number;
  readonly output: string;
}

/**
 * Run one command and collect everything it said.
 *
 * The output of both streams is kept together and printed by the caller,
 * because these programs report success on one and failure on the other and
 * neither is worth hiding: an operator watching a trust store change should see
 * what the operating system said about it.
 */
export async function runTrustCommand(argv: readonly string[]): Promise<CommandOutcome> {
  const [program, ...args] = argv;
  if (program === undefined) {
    throw new Error("there is no command to run on this platform");
  }

  return await new Promise<CommandOutcome>((settle, fail) => {
    // No shell: the path is an argument, and a path with a space or an
    // ampersand in it must not become two arguments or two commands.
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      fail(
        new Error(
          `${program} could not be run: ${error.message}. ` +
            "It is part of the operating system; if it is missing, install the certificate by hand.",
        ),
      );
    });
    child.on("close", (code) => {
      settle({ code: code ?? 1, output: output.trim() });
    });
  });
}
