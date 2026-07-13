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
  battleSimulationResponseSchema,
  errorResponseSchema,
} from "./schemas.js";

/**
 * `SimulateBattleUseCase`が要求するインターフェースのうち、Fastifyルートが
 * 使う`execute`だけを最小限で切り出す。presentationはdomainを直接import
 * できない（`no-restricted-imports`）ため、具体クラスではなくapplication層の
 * 型だけで表現したportとして受け取る。
 */
export interface SimulateBattleUseCasePort {
  execute(command: SimulateBattleCommand): SimulateBattleResult;
}

const ERROR_RESPONSES = {
  400: errorResponseSchema,
  406: errorResponseSchema,
  413: errorResponseSchema,
  415: errorResponseSchema,
  422: errorResponseSchema,
  500: errorResponseSchema,
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

function acceptsJson(header: string | string[] | undefined): boolean {
  if (header === undefined) {
    return true;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  return value.includes("application/json") || value.includes("*/*");
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
        request.log.error(error);
        void reply.code(500).send(toErrorResponseBody("INTERNAL_INVARIANT_VIOLATION", []));
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
