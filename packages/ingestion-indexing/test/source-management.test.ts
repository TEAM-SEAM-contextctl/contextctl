import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InMemorySourceObservationStore,
  SourceAdapterFault,
  SourceAdapterRegistry,
  SourceManagement,
  SourceManagementError,
  type CredentialResolver,
  type ProbedObservationCapability,
  type SourceAdapter,
  type SourceAdapterContext,
  type SourceChangeSignal,
  type SourceConfigurationResolver,
  type SourceIdGenerator,
  type SourceObservationAttempt,
  type SourceObservationStore,
  type ValidatedSourceConfiguration,
} from "../src/index.js";

const SOURCE_CONFIG = {
  locator: "https://knowledge.example.test/payments",
  scope: "payments",
};
const CAPTURED_AT = "2026-08-18T00:00:00.000Z";
const OBSERVATION_DIGEST = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("Source Management", () => {
  it("registers, inspects and observes a Source through its adapter", async () => {
    const adapter = new FakeSourceAdapter("document");
    const observations = new InMemorySourceObservationStore();
    const management = createManagement(
      [adapter],
      undefined,
      undefined,
      observations,
    );

    const registered = await management.register(registerCommand());
    const inspection = await management.inspect(registered);
    const observation = await management.requestObservation(inspection.source);

    expect(registered).toMatchObject({
      id: "src_test1",
      sourceType: "document",
      targetKey: "document:payments",
      lifecycleStatus: "active",
      inspectionStatus: { state: "unverified" },
      executionStatus: { state: "idle" },
    });
    expect(inspection.source.inspectionStatus).toEqual({
      state: "ready",
      capabilities: [
        { name: "content", status: "available" },
        {
          name: "metadata",
          status: "unavailable",
          diagnostic: {
            code: "permission_denied",
            detail: "Source capability unavailable: permission_denied",
          },
        },
      ],
    });
    expect(observation.attempt).toEqual({
      status: "changed",
      payload: { title: "Payments" },
      capturedAt: CAPTURED_AT,
      contentDigest: OBSERVATION_DIGEST,
      changeSignal: { status: "changed", token: "etag-2" },
    });
    expect(observation.source.executionStatus).toEqual({
      state: "succeeded",
      outcome: "changed",
    });
    expect(observation.changeSignal).toEqual({
      status: "changed",
      token: "etag-2",
    });
    expect(adapter.calls).toEqual({
      validateConfiguration: 3,
      validateConnection: 1,
      probeCapabilities: 1,
      observe: 1,
    });
    if (!("observation" in observation)) {
      throw new Error("changed observation was not persisted");
    }
    await expect(observations.count()).resolves.toBe(1);
    await expect(
      observations.latestForSource(registered.id),
    ).resolves.toEqual(observation.observation);
  });

  it("does not observe when the cheap change signal is unchanged", async () => {
    const adapter = new FakeSourceAdapter("document");
    adapter.changeSignal = { status: "unchanged", token: "etag-1" };
    const observations = new InMemorySourceObservationStore();
    const management = createManagement(
      [adapter],
      undefined,
      undefined,
      observations,
    );
    const source = (await management.inspect(await management.register(
      registerCommand(),
    ))).source;

    const result = await management.requestObservation(source, {
      previousChangeToken: "etag-1",
    });

    expect(result.attempt).toEqual({ status: "unchanged" });
    expect(result.changeSignal).toEqual({
      status: "unchanged",
      token: "etag-1",
    });
    expect(result.source.executionStatus).toEqual({
      state: "succeeded",
      outcome: "unchanged",
    });
    expect(adapter.calls.observe).toBe(1);
    await expect(observations.count()).resolves.toBe(0);
  });

  it("rejects inline credentials before an adapter can connect", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement(
      [adapter],
      new MemoryConfigurationResolver({
        "source.payments": {
          ...SOURCE_CONFIG,
          apiKey: "obviously-fake-inline-value",
        },
      }),
    );

    await expect(management.register(registerCommand())).rejects.toMatchObject({
      code: "inline_credential",
    });
    expect(adapter.calls.validateConfiguration).toBe(0);
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("rejects credentials embedded in a locator URL", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement(
      [adapter],
      new MemoryConfigurationResolver({
        "source.payments":
          "https://user:obviously-fake@knowledge.example.test/payments",
      }),
    );

    await expect(management.register(registerCommand())).rejects.toMatchObject({
      code: "inline_credential",
    });
    expect(adapter.calls.validateConfiguration).toBe(0);
  });

  it("rejects credentials emitted in a canonical target key", async () => {
    const adapter = new FakeSourceAdapter("document");
    adapter.targetKey =
      "document:payments|api_key=obviously-fake";
    const management = createManagement([adapter]);

    await expect(management.register(registerCommand())).rejects.toMatchObject({
      code: "inline_credential",
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("rejects malformed Source configuration before connecting", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement(
      [adapter],
      new MemoryConfigurationResolver({
        "source.payments": { locator: SOURCE_CONFIG.locator },
      }),
    );

    await expect(management.register(registerCommand())).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("distinguishes unavailable configuration and credential references", async () => {
    const adapter = new FakeSourceAdapter("document");
    const missingConfiguration = createManagement(
      [adapter],
      new MemoryConfigurationResolver({}),
    );

    await expect(
      missingConfiguration.register(registerCommand()),
    ).rejects.toMatchObject({
      code: "configuration_unavailable",
    });

    const unavailableCredential = createManagement(
      [adapter],
      new MemoryConfigurationResolver({
        "source.payments": SOURCE_CONFIG,
      }),
      new FailingCredentialResolver(),
    );
    const source = await unavailableCredential.register(registerCommand());

    await expect(unavailableCredential.inspect(source)).rejects.toMatchObject({
      code: "credential_unavailable",
      sourceId: source.id,
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it.each([
    "permission_denied",
    "invalid_format",
    "target_not_found",
    "connection_failed",
  ] as const)("preserves the safe adapter failure code %s", async (code) => {
    const adapter = new FakeSourceAdapter("document");
    adapter.connectionError = new SourceAdapterFault(code);
    const management = createManagement([adapter]);
    const source = await management.register(registerCommand());

    const error = await management
      .inspect(source)
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code,
      sourceId: source.id,
      message: `Source operation failed: ${code}`,
      source: {
        inspectionStatus: {
          state: "unavailable",
          diagnostic: {
            code,
            detail: `Source operation failed: ${code}`,
          },
        },
      },
    });
  });

  it("maps an adapter exception without exposing its message", async () => {
    const adapter = new FakeSourceAdapter("document");
    adapter.connectionError = new Error(
      "obviously-fake credential appeared in an SDK error",
    );
    const management = createManagement([adapter]);
    const source = await management.register(registerCommand());

    const error = await management
      .inspect(source)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SourceManagementError);
    expect(error).toMatchObject({ code: "adapter_failure" });
    expect(String(error)).not.toContain("obviously-fake credential");
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("obviously-fake credential");
  });

  it("maps deadline expiry to timeout and aborts the adapter", async () => {
    vi.useFakeTimers();
    const adapter = new FakeSourceAdapter("document");
    adapter.connection = ({ signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("adapter aborted")),
          { once: true },
        );
      });
    const management = createManagement([adapter]);
    const source = await management.register(registerCommand());

    const inspection = management.inspect(source, { timeoutMs: 25 });
    const rejection = expect(inspection).rejects.toMatchObject({
      code: "timeout",
      sourceId: source.id,
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("applies one deadline across configuration and adapter work", async () => {
    vi.useFakeTimers();
    const adapter = new FakeSourceAdapter("document");
    adapter.connection = ({ signal }) => delayedResolution(20, signal);
    const source = await createManagement([adapter]).register(
      registerCommand(),
    );
    const configurations = new DelayedConfigurationResolver(20);
    const management = createManagement([adapter], configurations);

    const inspection = management.inspect(source, {
      timeoutMs: 30,
    });
    const rejection = expect(inspection).rejects.toMatchObject({
      code: "timeout",
      sourceId: source.id,
    });
    await vi.advanceTimersByTimeAsync(30);

    await rejection;
  });

  it("maps caller cancellation separately from timeout", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement([adapter]);
    const source = await management.register(registerCommand());
    const controller = new AbortController();
    controller.abort();

    const error = await management
      .inspect(source, { signal: controller.signal })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "cancelled",
      sourceId: source.id,
      source: {
        inspectionStatus: { state: "unverified" },
      },
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("rejects an invalid timeout without changing Source health", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement([adapter]);
    const source = await management.register(registerCommand());

    const error = await management
      .inspect(source, { timeoutMs: 0 })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "invalid_request",
      sourceId: source.id,
      source: {
        inspectionStatus: { state: "unverified" },
      },
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("dispatches a newly registered Source type without changing the use case", async () => {
    const documentAdapter = new FakeSourceAdapter("document");
    const ledgerAdapter = new FakeSourceAdapter("ledger");
    const management = createManagement([documentAdapter, ledgerAdapter]);

    const source = await management.register({
      ...registerCommand(),
      sourceType: "ledger",
    });
    await management.inspect(source);

    expect(source.sourceType).toBe("ledger");
    expect(ledgerAdapter.calls.validateConnection).toBe(1);
    expect(documentAdapter.calls.validateConnection).toBe(0);
  });

  it("rejects a changed canonical target before connecting", async () => {
    const adapter = new FakeSourceAdapter("document");
    const configurations = new MemoryConfigurationResolver({
      "source.payments": SOURCE_CONFIG,
    });
    const management = createManagement([adapter], configurations);
    const source = await management.register(registerCommand());
    configurations.values["source.payments"] = {
      ...SOURCE_CONFIG,
      scope: "refunds",
    };

    await expect(management.inspect(source)).rejects.toMatchObject({
      code: "invalid_configuration",
      sourceId: source.id,
    });
    expect(adapter.calls.validateConnection).toBe(0);
  });

  it("returns failed execution state without an observation payload", async () => {
    const adapter = new FakeSourceAdapter("document");
    adapter.observationError = new SourceAdapterFault("invalid_format");
    const observations = new InMemorySourceObservationStore();
    const management = createManagement(
      [adapter],
      undefined,
      undefined,
      observations,
    );
    const ready = (
      await management.inspect(await management.register(registerCommand()))
    ).source;

    const error = await management
      .requestObservation(ready)
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "invalid_format",
      sourceId: ready.id,
      source: {
        executionStatus: {
          state: "failed",
          diagnostic: {
            code: "invalid_format",
            detail: "Source operation failed: invalid_format",
          },
        },
      },
    });
    expect(error).not.toHaveProperty("attempt");
    expect(adapter.calls.observe).toBe(1);
    await expect(observations.count()).resolves.toBe(0);
  });

  it("prevents observation before inspection and disables through the application boundary", async () => {
    const adapter = new FakeSourceAdapter("document");
    const management = createManagement([adapter]);
    const registered = await management.register(registerCommand());

    await expect(
      management.requestObservation(registered),
    ).rejects.toMatchObject({
      code: "invalid_source_state",
      sourceId: registered.id,
    });

    const ready = (await management.inspect(registered)).source;
    adapter.changeSignal = { status: "unchanged" };
    const completed = await management.requestObservation(ready);
    const disabled = management.disable(completed.source);
    expect(disabled.lifecycleStatus).toBe("disabled");
    await expect(management.inspect(disabled)).rejects.toMatchObject({
      code: "invalid_source_state",
      sourceId: disabled.id,
    });
    expect(adapter.calls.validateConnection).toBe(1);
  });

  it("prevents concurrent observations of the same Source", async () => {
    const adapter = new FakeSourceAdapter("document");
    let completeObservation:
      | ((attempt: SourceObservationAttempt) => void)
      | undefined;
    adapter.observation = () =>
      new Promise<SourceObservationAttempt>((resolve) => {
        completeObservation = resolve;
      });
    const management = createManagement([adapter]);
    const ready = (
      await management.inspect(await management.register(registerCommand()))
    ).source;

    const first = management.requestObservation(ready);
    await vi.waitFor(() => expect(adapter.calls.observe).toBe(1));

    await expect(management.requestObservation(ready)).rejects.toMatchObject({
      code: "observation_in_progress",
      sourceId: ready.id,
    });
    expect(() => management.disable(ready)).toThrow(
      expect.objectContaining({ code: "observation_in_progress" }),
    );

    completeObservation?.({
      status: "changed",
      payload: { title: "Payments" },
      capturedAt: CAPTURED_AT,
      contentDigest: OBSERVATION_DIGEST,
      changeSignal: { status: "changed", token: "etag-2" },
    });
    await expect(first).resolves.toMatchObject({
      attempt: { status: "changed" },
    });
  });

  it("replaces a credential reference without changing Source identity", async () => {
    const management = createManagement([new FakeSourceAdapter("document")]);
    const source = await management.register(registerCommand());

    const replaced = management.replaceCredentialReference(
      source,
      "credential.rotated",
    );
    const removed = management.replaceCredentialReference(replaced);

    expect(replaced).toMatchObject({
      id: source.id,
      sourceType: source.sourceType,
      targetKey: source.targetKey,
      credentialReference: "credential.rotated",
    });
    expect(removed.id).toBe(source.id);
    expect(removed.targetKey).toBe(source.targetKey);
    expect(removed).not.toHaveProperty("credentialReference");
  });
});

function registerCommand() {
  return {
    sourceType: "document",
    displayName: "Payments knowledge",
    configReference: "source.payments",
    credentialReference: "credential.payments",
    polling: { enabled: true, intervalMs: 60_000 },
  } as const;
}

function createManagement(
  adapters: readonly SourceAdapter[],
  configurations: SourceConfigurationResolver = new MemoryConfigurationResolver(
    { "source.payments": SOURCE_CONFIG },
  ),
  credentials: CredentialResolver = new FakeCredentialResolver(),
  observations: SourceObservationStore = new InMemorySourceObservationStore(),
): SourceManagement {
  return new SourceManagement({
    adapters: new SourceAdapterRegistry(adapters),
    configurations,
    credentials,
    ids: new SequentialSourceIdGenerator(),
    observations,
    defaultTimeoutMs: 1_000,
    clock: () => CAPTURED_AT,
  });
}

class MemoryConfigurationResolver implements SourceConfigurationResolver {
  constructor(readonly values: Record<string, unknown>) {}

  async resolve(reference: string): Promise<unknown> {
    if (!(reference in this.values)) {
      throw new Error("configuration missing");
    }
    return this.values[reference];
  }
}

class DelayedConfigurationResolver implements SourceConfigurationResolver {
  constructor(readonly delayMs: number) {}

  async resolve(
    _reference: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    await delayedResolution(this.delayMs, signal);
    return SOURCE_CONFIG;
  }
}

class FakeCredentialResolver implements CredentialResolver {
  async resolve(): Promise<unknown> {
    return { value: "obviously-fake-resolved-credential" };
  }
}

class FailingCredentialResolver implements CredentialResolver {
  async resolve(): Promise<never> {
    throw new Error("obviously-fake credential store error");
  }
}

class SequentialSourceIdGenerator implements SourceIdGenerator {
  #next = 1;

  nextSourceId(): string {
    return `src_test${this.#next++}`;
  }
}

class FakeSourceAdapter implements SourceAdapter {
  readonly calls = {
    validateConfiguration: 0,
    validateConnection: 0,
    probeCapabilities: 0,
    observe: 0,
  };

  changeSignal: SourceChangeSignal = { status: "changed", token: "etag-2" };
  targetKey?: string;
  connectionError?: Error;
  observationError?: Error;
  connection: (context: SourceAdapterContext) => Promise<void> = async () => {};
  observation: (
    context: SourceAdapterContext,
  ) => Promise<SourceObservationAttempt> = async () => ({
    status: "changed",
    payload: { title: "Payments" },
    capturedAt: CAPTURED_AT,
    contentDigest: OBSERVATION_DIGEST,
    changeSignal: { status: "changed", token: "etag-2" },
  });

  constructor(readonly sourceType: string) {}

  validateConfiguration(input: unknown): ValidatedSourceConfiguration {
    this.calls.validateConfiguration += 1;
    if (
      typeof input !== "object" ||
      input === null ||
      !("scope" in input) ||
      typeof input.scope !== "string"
    ) {
      throw new SourceAdapterFault("invalid_configuration");
    }
    return {
      targetKey: this.targetKey ?? `${this.sourceType}:${input.scope}`,
      value: input,
    };
  }

  async validateConnection(context: SourceAdapterContext): Promise<void> {
    this.calls.validateConnection += 1;
    if (this.connectionError !== undefined) {
      throw this.connectionError;
    }
    await this.connection(context);
  }

  async probeCapabilities(): Promise<
    readonly ProbedObservationCapability[]
  > {
    this.calls.probeCapabilities += 1;
    return [
      {
        name: "metadata",
        status: "unavailable",
        diagnosticCode: "permission_denied",
      },
      { name: "content", status: "available" },
    ];
  }

  async observe(
    context: SourceAdapterContext,
    _previousToken?: string,
  ): Promise<SourceObservationAttempt> {
    this.calls.observe += 1;
    if (this.observationError !== undefined) {
      throw this.observationError;
    }
    if (this.changeSignal.status === "unchanged") {
      return { status: "unchanged" };
    }
    return this.observation(context);
  }
}

function delayedResolution(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("operation aborted"));
      },
      { once: true },
    );
  });
}
