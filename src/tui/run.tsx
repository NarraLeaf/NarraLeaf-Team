/**
 * Running the interface against a real terminal.
 *
 * This is the only file under src/tui that touches a process. It reads keys,
 * asks the host to carry out whatever they meant, and draws the view it is
 * given back; it opens nothing and writes nothing itself.
 */
import { render, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useState } from "react";

import { Interface } from "./app.js";
import type { TeamView } from "../teamview.js";
import { INITIAL_STATE, reduce, type Action, type KeyPress, type Session, type TuiSize } from "./state.js";

/**
 * What the interface cannot do for itself.
 *
 * Every action here has a command that does the same thing, and the host meets
 * it by calling what that command calls. Two hosts over one set of operations
 * is the whole point: the moment this interface learned to write a row itself,
 * it and the command line would start to drift, and only one of them is
 * covered by the tests that matter.
 */
export interface Operations {
  /** Gather the view again. Called after anything that changed something. */
  readonly refresh: () => Promise<TeamView>;
  /** Carry one action out, and say in one line what it did. */
  readonly perform: (action: Action) => Promise<string>;
  /**
   * Watch for a view that arrived without anybody asking, and stop watching.
   *
   * Some of what is drawn is not in the database and cannot be gathered
   * without waiting on a network: it turns up later, and when it does, this is
   * how the screen is told. The interface still fetches nothing — it is handed
   * a finished view here exactly as it is everywhere else.
   */
  readonly subscribe?: (listen: (view: TeamView) => void) => () => void;
}

/** A terminal that has not said how big it is is assumed to be the smallest one. */
const FALLBACK: TuiSize = { columns: 80, rows: 24 };

function useTerminalSize(): TuiSize {
  const { stdout } = useStdout();
  const measure = useCallback(
    (): TuiSize => ({ columns: stdout.columns ?? FALLBACK.columns, rows: stdout.rows ?? FALLBACK.rows }),
    [stdout],
  );
  const [size, setSize] = useState<TuiSize>(measure);
  useEffect(() => {
    const update = (): void => {
      setSize(measure());
    };
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout, measure]);
  return size;
}

/** Ink's key, as the reducer wants it. */
function pressOf(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): KeyPress {
  return {
    input,
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    return: key.return,
    escape: key.escape,
    tab: key.tab,
    shift: key.shift,
    backspace: key.backspace,
    delete: key.delete,
    ctrl: key.ctrl,
    meta: key.meta,
  };
}

function App({ first, operations }: { first: TeamView; operations: Operations }): ReturnType<typeof Interface> {
  const { exit } = useApp();
  const size = useTerminalSize();
  const [view, setView] = useState<TeamView>(first);
  const [session, setSession] = useState<Session>({ state: INITIAL_STATE, draft: "" });
  const [status, setStatus] = useState<string | undefined>(undefined);

  useEffect(() => operations.subscribe?.(setView), [operations]);

  useInput((input, key) => {
    const step = reduce(session, pressOf(input, key), view);
    setSession(step.session);
    // Whatever the last action said has been read by now, and leaving it up
    // would attach it to the next thing somebody did.
    setStatus(undefined);

    const { action } = step;
    if (action === undefined) {
      return;
    }
    if (action.kind === "quit") {
      exit();
      return;
    }

    void (async () => {
      try {
        if (action.kind !== "refresh") {
          setStatus(await operations.perform(action));
        }
        setView(await operations.refresh());
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  return (
    <Interface
      state={session.state}
      size={size}
      view={view}
      draft={session.draft}
      {...(status === undefined ? {} : { status })}
    />
  );
}

/**
 * Draw the interface until somebody leaves it.
 *
 * The alternate screen is what gives it back afterwards: everything it drew
 * belongs to a screen the terminal throws away, so the scrollback an operator
 * was reading before is still there. The unmount is in a `finally` because a
 * crash that left the terminal on that screen would leave a person with no
 * prompt and no way to know why.
 */
export async function runInterface(view: TeamView, operations: Operations): Promise<void> {
  const instance = render(<App first={view} operations={operations} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
  }
}
