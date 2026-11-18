import {
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { EffectLevel } from "../effects";
import { useServices } from "../services";
import { useGpuAccelerated } from "../useGpuAccelerated";

import {
  connectTerminal,
  type TerminalConnection,
  type TerminalState,
} from "./connection";
import { TerminalFactoryContext } from "./xterm";

interface Outcome {
  cwd: string;
  attempt: number;
  state: TerminalState;
}

export interface UseTerminal {
  state: TerminalState;
  retry: () => void;
}

const STARTING: TerminalState = { kind: "starting" };

export function useTerminal(
  cwd: string,
  hostRef: RefObject<HTMLElement | null>,
  level: EffectLevel,
): UseTerminal {
  const { client } = useServices();
  const factory = use(TerminalFactoryContext);
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const gpuAccelerated = useGpuAccelerated();
  const connectionRef = useRef<TerminalConnection | null>(null);
  const createHandle = useEffectEvent((host: HTMLElement) =>
    factory(host, { level, gpuAccelerated }),
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return undefined;
    }
    const connection = connectTerminal({
      client,
      host,
      cwd,
      createHandle,
      report: (state) => {
        setOutcome({ cwd, attempt, state });
      },
    });
    connectionRef.current = connection;
    return () => {
      connectionRef.current = null;
      connection.stop();
    };
  }, [client, cwd, attempt, hostRef]);

  useEffect(() => {
    connectionRef.current?.setLevel(level);
  }, [level]);

  useEffect(() => {
    connectionRef.current?.setGpuAccelerated(gpuAccelerated);
  }, [gpuAccelerated]);

  const current = outcome?.cwd === cwd && outcome.attempt === attempt;
  return {
    state: current ? outcome.state : STARTING,
    retry: () => {
      setAttempt((previous) => previous + 1);
    },
  };
}
