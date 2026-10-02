import {
  Delegation,
  DelegationAccess,
  DelegationExecutionMode,
  DelegationId,
  DelegationStatus,
  DelegationWorkspaceMode,
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

export type DelegationRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/**
 * Persisted delegation records. One row per delegation, rewritten whole on each
 * transition; the thread event log stays the record of what the child did.
 */
export class DelegationRepository extends Context.Service<
  DelegationRepository,
  {
    readonly upsert: (delegation: Delegation) => Effect.Effect<void, DelegationRepositoryError>;
    readonly getById: (
      id: DelegationId,
    ) => Effect.Effect<Option.Option<Delegation>, DelegationRepositoryError>;
    readonly getByChildThreadId: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<Delegation>, DelegationRepositoryError>;
    /** Newest first. */
    readonly listByParentThreadId: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<Delegation>, DelegationRepositoryError>;
    /** Every delegation not yet completed, failed, cancelled or timed out. */
    readonly listActive: Effect.Effect<ReadonlyArray<Delegation>, DelegationRepositoryError>;
  }
>()("t3/delegation/DelegationRepository") {}

/**
 * The fork keeps its own migration ledger. Upstream's migrator only runs ids
 * above the highest it has recorded, so a fork migration numbered into that
 * sequence would either collide with a future upstream id or make upstream
 * skip its own later migrations.
 */
const MIGRATIONS_TABLE = "fork_delegation_migrations";

const Migration0001 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      parent_turn_id TEXT,
      child_thread_id TEXT NOT NULL UNIQUE,
      requested_provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      model TEXT NOT NULL,
      role TEXT,
      task TEXT NOT NULL,
      access TEXT NOT NULL,
      workspace_mode TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      deadline_at TEXT NOT NULL,
      result TEXT,
      failure_code TEXT,
      failure_message TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegations_parent
    ON delegations (parent_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegations_status
    ON delegations (status)
  `;
});

const Migration0002 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE delegations ADD COLUMN profile TEXT`;
});

const runDelegationMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    "1_Delegations": Migration0001,
    "2_DelegationProfile": Migration0002,
  }),
  table: MIGRATIONS_TABLE,
});

const DelegationRow = Schema.Struct({
  id: DelegationId,
  parentThreadId: ThreadId,
  parentTurnId: Schema.NullOr(TurnId),
  childThreadId: ThreadId,
  requestedProvider: Schema.String,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: Schema.String,
  role: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(Schema.String),
  task: Schema.String,
  access: DelegationAccess,
  workspaceMode: DelegationWorkspaceMode,
  executionMode: DelegationExecutionMode,
  depth: Schema.Int,
  status: DelegationStatus,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  deadlineAt: IsoDateTime,
  result: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  failureMessage: Schema.NullOr(Schema.String),
});
type DelegationRow = typeof DelegationRow.Type;

const decodeDelegation = Schema.decodeUnknownEffect(Delegation);

const fromRow = ({ failureCode, failureMessage, ...row }: DelegationRow) =>
  decodeDelegation({
    ...row,
    failure:
      failureCode === null ? null : { code: failureCode, message: failureMessage ?? failureCode },
  });

const toRow = ({ failure, ...delegation }: Delegation): DelegationRow => ({
  ...delegation,
  failureCode: failure?.code ?? null,
  failureMessage: failure?.message ?? null,
});

const selectColumns = (sql: SqlClient.SqlClient) => sql`
  SELECT
    id,
    parent_thread_id AS "parentThreadId",
    parent_turn_id AS "parentTurnId",
    child_thread_id AS "childThreadId",
    requested_provider AS "requestedProvider",
    provider_instance_id AS "providerInstanceId",
    driver,
    model,
    role,
    profile,
    task,
    access,
    workspace_mode AS "workspaceMode",
    execution_mode AS "executionMode",
    depth,
    status,
    created_at AS "createdAt",
    started_at AS "startedAt",
    completed_at AS "completedAt",
    deadline_at AS "deadlineAt",
    result,
    failure_code AS "failureCode",
    failure_message AS "failureMessage"
  FROM delegations
`;

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): DelegationRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runDelegationMigrations.pipe(
    Effect.mapError(toRepositoryError("DelegationRepository.migrate")),
  );

  const upsertRow = SqlSchema.void({
    Request: DelegationRow,
    execute: (row) => sql`
      INSERT INTO delegations (
        id, parent_thread_id, parent_turn_id, child_thread_id, requested_provider,
        provider_instance_id, driver, model, role, profile, task, access, workspace_mode,
        execution_mode, depth, status, created_at, started_at, completed_at, deadline_at, result,
        failure_code, failure_message
      )
      VALUES (
        ${row.id}, ${row.parentThreadId}, ${row.parentTurnId}, ${row.childThreadId},
        ${row.requestedProvider}, ${row.providerInstanceId}, ${row.driver}, ${row.model},
        ${row.role}, ${row.profile}, ${row.task}, ${row.access}, ${row.workspaceMode}, ${row.executionMode},
        ${row.depth}, ${row.status}, ${row.createdAt}, ${row.startedAt}, ${row.completedAt},
        ${row.deadlineAt}, ${row.result}, ${row.failureCode}, ${row.failureMessage}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        result = excluded.result,
        failure_code = excluded.failure_code,
        failure_message = excluded.failure_message
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: DelegationId,
    Result: DelegationRow,
    execute: (id) => sql`${selectColumns(sql)} WHERE id = ${id}`,
  });

  const findByChild = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: DelegationRow,
    execute: (threadId) => sql`${selectColumns(sql)} WHERE child_thread_id = ${threadId}`,
  });

  const findByParent = SqlSchema.findAll({
    Request: ThreadId,
    Result: DelegationRow,
    execute: (threadId) => sql`
      ${selectColumns(sql)}
      WHERE parent_thread_id = ${threadId}
      ORDER BY created_at DESC, id DESC
    `,
  });

  const findActive = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DelegationRow,
    execute: () => sql`
      ${selectColumns(sql)}
      WHERE status IN ('queued', 'starting', 'running')
      ORDER BY created_at ASC
    `,
  });

  const decodeOne = (row: Option.Option<DelegationRow>) =>
    Option.isNone(row) ? Effect.succeedNone : fromRow(row.value).pipe(Effect.asSome);

  return DelegationRepository.of({
    upsert: (delegation) =>
      upsertRow(toRow(delegation)).pipe(Effect.mapError(toRepositoryError("delegations.upsert"))),
    getById: (id) =>
      findById(id).pipe(
        Effect.flatMap(decodeOne),
        Effect.mapError(toRepositoryError("delegations.getById")),
      ),
    getByChildThreadId: (threadId) =>
      findByChild(threadId).pipe(
        Effect.flatMap(decodeOne),
        Effect.mapError(toRepositoryError("delegations.getByChildThreadId")),
      ),
    listByParentThreadId: (threadId) =>
      findByParent(threadId).pipe(
        Effect.flatMap(Effect.forEach(fromRow)),
        Effect.mapError(toRepositoryError("delegations.listByParentThreadId")),
      ),
    listActive: findActive(undefined).pipe(
      Effect.flatMap(Effect.forEach(fromRow)),
      Effect.mapError(toRepositoryError("delegations.listActive")),
    ),
  });
});

export const layer = Layer.effect(DelegationRepository, make);
