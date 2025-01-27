import * as M from "@matechs/effect";
import { pipe } from "fp-ts/lib/pipeable";
import {
  Tracer as OT,
  Span as OS,
  FORMAT_HTTP_HEADERS,
  Tags
} from "opentracing";
import { Do } from "fp-ts-contrib/lib/Do";
import { ERROR } from "opentracing/lib/ext/tags";
import Span from "opentracing/lib/span";
import { IO } from "fp-ts/lib/IO";

export interface TracerFactory {
  tracer: {
    factory: M.Effect<M.NoEnv, never, OT>;
  };
}

export const tracerFactoryDummy: TracerFactory = {
  tracer: {
    factory: M.liftIO(() => new OT())
  }
};

export interface HasTracerContext {
  tracer: {
    context: {
      tracerInstance: OT;
    };
  };
}

export interface HasSpanContext {
  span: {
    context: {
      spanInstance: OS;
      component: string;
    };
  };
}

export interface Tracer {
  tracer: {
    withTracer<R, E, A>(
      ma: M.Effect<HasTracerContext & R, E, A>
    ): M.Effect<R & TracerFactory, E, A>;
    withControllerSpan(
      component: string,
      operation: string,
      headers: { [k: string]: string }
    ): <R, A>(
      ma: M.Effect<HasSpanContext & R, Error, A>
    ) => M.Effect<HasTracerContext & R, Error, A>;
    withChildSpan(
      operation: string
    ): <R, A>(ma: M.Effect<R, Error, A>) => M.Effect<R, Error, A>;
  };
}

function runWithSpan<R, A>(
  ma: M.Effect<HasSpanContext & R, Error, A>,
  span: Span,
  component: string
) {
  return pipe(
    ma,
    x =>
      M.chainLeft(x, e =>
        pipe(
          M.liftIO(() => {
            span.setTag(ERROR, e.message);
            span.finish();
          }),
          M.chain(() => M.left(e))
        )
      ),
    M.chain(r =>
      Do(M.effectMonad)
        .do(
          M.liftIO(() => {
            span.finish();
          })
        )
        .return(() => r)
    ),
    M.provide<HasSpanContext>({
      span: {
        context: { spanInstance: span, component }
      }
    })
  );
}

export function createControllerSpan(
  tracer: OT,
  component: string,
  operation: string,
  headers: any
): IO<Span> {
  return () => {
    let traceSpan: Span;
    // NOTE: OpenTracing type definitions at
    // <https://github.com/opentracing/opentracing-javascript/blob/master/src/tracer.ts>
    const parentSpanContext = tracer.extract(FORMAT_HTTP_HEADERS, headers);

    if (
      parentSpanContext &&
      parentSpanContext.toSpanId &&
      parentSpanContext.toSpanId().length > 0
    ) {
      traceSpan = tracer.startSpan(operation, {
        childOf: parentSpanContext,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
          [Tags.COMPONENT]: component
        }
      });
    } else {
      traceSpan = tracer.startSpan(operation, {
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
          [Tags.COMPONENT]: component
        }
      });
    }

    return traceSpan;
  };
}

export const tracer: Tracer = {
  tracer: {
    withTracer<R, E, A>(
      ma: M.Effect<HasTracerContext & R, E, A>
    ): M.Effect<R & TracerFactory, E, A> {
      return M.accessM(({ tracer: { factory } }: TracerFactory) =>
        Do(M.effectMonad)
          .bind("instance", factory)
          .bindL("res", ({ instance }) =>
            M.provide<HasTracerContext>({
              tracer: { context: { tracerInstance: instance } }
            })(ma)
          )
          .return(s => s.res)
      );
    },
    withControllerSpan(
      component: string,
      operation: string,
      headers: { [k: string]: string }
    ): <R, A>(
      ma: M.Effect<HasSpanContext & R, Error, A>
    ) => M.Effect<R & HasTracerContext, Error, A> {
      return ma =>
        M.accessM(
          ({
            tracer: {
              context: { tracerInstance }
            }
          }: HasTracerContext) =>
            Do(M.effectMonad)
              .bindL("span", () =>
                M.liftIO(
                  createControllerSpan(
                    tracerInstance,
                    component,
                    operation,
                    headers
                  )
                )
              )
              .bindL("res", ({ span }) => runWithSpan(ma, span, component))
              .return(s => s.res)
        );
    },
    withChildSpan(
      operation: string
    ): <R, A>(ma: M.Effect<R, Error, A>) => M.Effect<R, Error, A> {
      return <R, A>(ma: M.Effect<R, Error, A>) =>
        M.accessM((r: R) =>
          hasChildContext(r)
            ? Do(M.effectMonad)
                .bindL("span", () =>
                  M.liftIO(() =>
                    r.tracer.context.tracerInstance.startSpan(operation, {
                      childOf: r.span.context.spanInstance
                    })
                  )
                )
                .bindL("res", ({ span }) =>
                  runWithSpan(ma, span, r.span.context.component)
                )
                .return(s => s.res)
            : ma
        );
    }
  }
};

export function withTracer<R, E, A>(ma: M.Effect<HasTracerContext & R, E, A>) {
  return M.accessM(({ tracer }: Tracer) => tracer.withTracer(ma));
}

export function withControllerSpan(
  component: string,
  operation: string,
  headers: { [k: string]: string } = {}
) {
  return <R, A>(
    ma: M.Effect<HasSpanContext & R, Error, A>
  ): M.Effect<HasTracerContext & Tracer & R, Error, A> =>
    M.accessM(({ tracer }: Tracer) =>
      tracer.withControllerSpan(component, operation, headers)(ma)
    );
}

export function withChildSpan(operation: string) {
  return <R, A>(ma: M.Effect<R, Error, A>): M.Effect<Tracer & R, Error, A> =>
    M.accessM(({ tracer }: Tracer) => tracer.withChildSpan(operation)(ma));
}

// provide opt-out utility for components of the ecosystem that integrate tracing
// this can be used if you don't want to configure tracing
export function noTracing<R, A>(
  op: M.Effect<
    Tracer & TracerFactory & ChildContext & HasTracerContext & R,
    Error,
    A
  >
): M.Effect<R, Error, A> {
  return M.provide(
    pipe(M.noEnv, M.mergeEnv(tracer), M.mergeEnv(tracerFactoryDummy))
  )(withTracer(withControllerSpan("no-tracing", "dummy-controller")(op)));
}

export type ChildContext = HasSpanContext & HasTracerContext;

export function hasChildContext(t: any): t is ChildContext {
  return t && t.span && t.span.context && t.tracer && t.tracer.context;
}
