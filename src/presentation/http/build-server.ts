import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifySwagger from "@fastify/swagger";
import { toSimulateBattleCommand } from "../../application/simulate-battle-request-mapper.js";
import { toBattleSimulationResponseBody } from "../../application/simulate-battle-response-mapper.js";
import { ApplicationError } from "../../application/application-error.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";
import type { SimulateBattleCommand } from "../../application/simulate-battle-command.js";
import type { SimulateBattleResult } from "../../application/simulation-result-assembler.js";
import { fromApplicationError, toErrorResponseBody } from "./error-response-mapper.js";
import {
  battleSimulationRequestSchema,
  battleSimulationRequestDocSchema,
  battleSimulationResponseSchema,
  battleSimulationResponseDocSchema,
  errorResponseSchema,
} from "./schemas.js";

const BATTLE_SIMULATIONS_PATH = "/api/v1/battle-simulations";

/**
 * `SimulateBattleUseCase`が要求するインターフェースのうち、Fastifyルートが
 * 使う`execute`だけを最小限で切り出す。presentationはdomainを直接import
 * できない（`no-restricted-imports`）ため、具体クラスではなくapplication層の
 * 型だけで表現したportとして受け取る。
 */
export interface SimulateBattleUseCasePort {
  execute(command: SimulateBattleCommand): SimulateBattleResult;
}

/**
 * `10_API設計.md`「ステータスコード対応」の全エラーステータスをOpenAPI文書へ
 * 登録する。429/503/504は本Issueの範囲（`#12`/`#13`/`#18`）ではまだ実際の
 * トリガー（レート制限、Worker Pool容量、実行期限）を実装していないが、
 * 外部契約としては`10_API設計.md`が定義済みのため、Schemaだけ先に固定する。
 */
const ERROR_RESPONSES = {
  400: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  500: errorResponseSchema,
  503: errorResponseSchema,
  504: errorResponseSchema,
} as const;

const REQUEST_ID_PATTERN = /^[\x20-\x7E]{1,128}$/;
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB。`10_API設計.md`「編成入力自体は小さい」ための暫定上限。

export interface BuildServerOptions {
  readonly bodyLimit?: number;
}

function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && REQUEST_ID_PATTERN.test(value)) {
    return value;
  }
  return randomUUID();
}

interface AcceptEntry {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

/**
 * RFC 7231 `Accept`ヘッダーの`media-range[;q=value]`を単純にパースする。
 * RFC 9110 §8.3.1: media typeのtype/subtypeは大文字小文字を区別しないため、
 * 比較のために小文字へ正規化する（`q`パラメータ名自体は小文字固定のためそのまま）。
 */
function parseAcceptHeader(value: string): readonly AcceptEntry[] {
  return value.split(",").map((entry): AcceptEntry => {
    const [mediaRange = "*/*", ...params] = entry.split(";").map((part) => part.trim());
    const [type = "*", subtype = "*"] = mediaRange.toLowerCase().split("/");
    let q = 1;
    for (const param of params) {
      const [key, rawValue] = param.split("=").map((part) => part.trim());
      if (key === "q" && rawValue !== undefined) {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) {
          q = parsed;
        }
      }
    }
    return { type, subtype, q };
  });
}

/**
 * `10_API設計.md`「HTTPヘッダー」: `Accept`省略時は`application/json`と
 * みなす。指定されている場合は、最も詳細度の高い一致（完全一致、
 * 次に"application"のtypeワイルドカード、次に完全ワイルドカード）のq値で
 * 判定する。単純な部分文字列一致では `Accept: application/json;q=0` や
 * 完全ワイルドカードだけをq=0にする指定のような明示的な除外を見逃す
 * （q=0は「受理不可」を意味する、RFC 7231）。
 */
function acceptsJson(header: string | string[] | undefined): boolean {
  if (header === undefined) {
    return true;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  const entries = parseAcceptHeader(value);

  const exact = entries.find((entry) => entry.type === "application" && entry.subtype === "json");
  if (exact !== undefined) {
    return exact.q > 0;
  }
  const typeWildcard = entries.find(
    (entry) => entry.type === "application" && entry.subtype === "*",
  );
  if (typeWildcard !== undefined) {
    return typeWildcard.q > 0;
  }
  const fullWildcard = entries.find((entry) => entry.type === "*" && entry.subtype === "*");
  if (fullWildcard !== undefined) {
    return fullWildcard.q > 0;
  }
  return false;
}

/**
 * `10_API設計.md`「Fastify injectによる正常・400・413・415・422」他の契約を
 * 満たすFastifyインスタンスを構築する。Catalog・RandomSource・ID生成器の
 * 実配線（Composition Root）は本Issueの範囲外（`#12`/`#13`）とし、ここでは
 * 既に構築済みの`SimulateBattleUseCase`相当のportを受け取るだけにする。
 *
 * `@fastify/swagger`の`register`はavvioのbootキューへ積まれるだけで、
 * プラグイン本体（`onRoute`フックの登録）は`.ready()`まで実行されない。
 * 一方`app.post(...)`は`onRoute`フックを呼び出し時点で同期発火するため、
 * `register`をawaitせずにルートを定義すると、そのルートがOpenAPI文書へ
 * 反映されない。ここで`await`し、フック登録を確実にルート定義より先に
 * 完了させる。
 */
export async function buildServer(
  useCase: SimulateBattleUseCasePort,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
    ajv: {
      customOptions: {
        // 数値文字列を暗黙変換しない（`10_API設計.md`「数値を文字列として送信できない」）。
        coerceTypes: false,
        // additionalProperties:falseを「黙って除去」ではなく検証エラーにする
        // （`10_API設計.md`「未定義のトップレベルプロパティは拒否する」）。
        removeAdditional: false,
      },
    },
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "muvluvgg-battle-simulator API", version: "1" },
      paths: {},
    },
    // `10_API設計.md`はOpenAPIへ値域・列挙値の自動検証を要求するが、
    // `column`/`row`/`logLevel`/`turnLimit`などの値域違反は「422
    // INVALID_COMMAND」として集約検証したい（`schemas.ts`冒頭の注記）。
    // ここで公開文書だけ`battleSimulationRequestDocSchema`（値域・列挙値付き）
    // へ差し替え、実行時validationに使う`route.schema`本体は変更しない。
    // レスポンス側も同様に、`events[].details`のイベント種別ごとの構造は
    // `battleSimulationResponseDocSchema`で公開文書だけ書き足す
    // （実データがそのまま流れる出力を厳格化して壊さないよう、実行時
    // serializationは`battleSimulationResponseSchema`のまま変更しない）。
    transform: ({ schema, url }) => {
      if (url !== BATTLE_SIMULATIONS_PATH) {
        return { schema, url };
      }
      return {
        schema: {
          ...schema,
          ...(schema.body !== undefined ? { body: battleSimulationRequestDocSchema } : {}),
          ...(schema.response !== undefined
            ? { response: { ...schema.response, 200: battleSimulationResponseDocSchema } }
            : {}),
        },
        url,
      };
    },
  });

  app.addHook("onRequest", (request, reply, done) => {
    if (!acceptsJson(request.headers.accept)) {
      const body = toErrorResponseBody("NOT_ACCEPTABLE", []);
      void reply.code(406).send(body);
      return;
    }
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Request-Id", resolveRequestId(request.headers["x-request-id"]));
    done(null, payload);
  });

  app.setErrorHandler<FastifyError | ApplicationError>((error, request, reply) => {
    if (error instanceof ApplicationError) {
      const { status, body } = fromApplicationError(error);
      if (status >= 500) {
        // `10_API設計.md`「ErrorObject」diagnosticId: サーバーログと照合できるよう、
        // レスポンスへ返す診断IDと同じ値でログへも記録する。
        request.log.error({ diagnosticId: body.error.diagnosticId, err: error });
      }
      void reply.code(status).send(body);
      return;
    }

    switch (error.code) {
      case "FST_ERR_CTP_BODY_TOO_LARGE":
        void reply.code(413).send(toErrorResponseBody("REQUEST_TOO_LARGE", []));
        return;
      case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
        void reply.code(415).send(toErrorResponseBody("UNSUPPORTED_MEDIA_TYPE", []));
        return;
      case "FST_ERR_CTP_INVALID_JSON_BODY":
      case "FST_ERR_CTP_EMPTY_JSON_BODY":
        void reply.code(400).send(toErrorResponseBody("MALFORMED_REQUEST", []));
        return;
      case "FST_ERR_VALIDATION": {
        const violations = (error.validation ?? []).map((issue) => ({
          path: issue.instancePath.length > 0 ? issue.instancePath : "/",
          reason: issue.message ?? "is invalid",
        }));
        void reply.code(400).send(toErrorResponseBody("MALFORMED_REQUEST", violations));
        return;
      }
      default: {
        // `10_API設計.md`「情報公開」: スタックトレースや内部パスを返さない。
        // 「ErrorObject」diagnosticId: 予期しない例外も、生成したIDをレスポンス
        // とログの双方へ記録し、事後にサーバーログと照合できるようにする。
        const diagnosticId = randomUUID();
        request.log.error({ diagnosticId, err: error });
        void reply
          .code(500)
          .send(toErrorResponseBody("INTERNAL_INVARIANT_VIOLATION", [], diagnosticId));
      }
    }
  });

  app.post(
    "/api/v1/battle-simulations",
    {
      schema: {
        body: battleSimulationRequestSchema,
        response: { 200: battleSimulationResponseSchema, ...ERROR_RESPONSES },
      },
    },
    (request: FastifyRequest<{ Body: BattleSimulationRequestBody }>, reply: FastifyReply) => {
      const command = toSimulateBattleCommand(request.body);
      const result = useCase.execute(command);
      const body = toBattleSimulationResponseBody(result);
      void reply.code(200).send(body);
    },
  );

  app.get("/openapi.json", (_request, reply) => {
    void reply.send(app.swagger());
  });

  return app;
}
