import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatTimestamp, serviceColor } from "../format";
import { SeverityBadge, ServiceBadge } from "./shared";

export interface LogRecord {
  id: string;
  timestamp: Date;
  serviceName: string;
  severityText: string;
  body: string;
  traceId: string | null;
  spanId: string | null;
  scopeName: string | null;
  attributes: Record<string, string>;
}

interface Props {
  logs: LogRecord[];
  className?: string;
  traceScoped?: boolean;
  onSelectSpan?: (spanId: string | null) => void;
  initialExpandedId?: string | null;
  expandedId?: string | null;
  onExpandedIdChange?: (id: string | null) => void;
}

export function LogTable({
  logs,
  className = "",
  traceScoped = false,
  onSelectSpan,
  initialExpandedId = null,
  expandedId: controlledExpandedId,
  onExpandedIdChange,
}: Props) {
  const [uncontrolledExpandedId, setUncontrolledExpandedId] = useState<
    string | null
  >(initialExpandedId);
  const isControlled = controlledExpandedId !== undefined;
  const expandedId = isControlled ? controlledExpandedId : uncontrolledExpandedId;

  useEffect(() => {
    if (!isControlled) setUncontrolledExpandedId(initialExpandedId);
  }, [isControlled, initialExpandedId]);

  const setExpandedId = (id: string | null) => {
    if (!isControlled) setUncontrolledExpandedId(id);
    onExpandedIdChange?.(id);
  };

  return (
    <div className={`overflow-auto ${className}`}>
      <table className="w-full min-w-[760px] border-separate border-spacing-0">
        <thead className="sticky top-0 z-10 bg-zinc-950">
          <tr className="text-left text-sm text-zinc-500">
            <th className="whitespace-nowrap border-b border-white/10 py-3 pl-6 pr-4 font-medium w-[9rem]">
              Time
            </th>
            <th className="whitespace-nowrap border-b border-white/10 py-3 px-4 font-medium w-24">
              Level
            </th>
            {!traceScoped && (
              <th className="whitespace-nowrap border-b border-white/10 py-3 px-4 font-medium w-40">
                Service
              </th>
            )}
            <th className="whitespace-nowrap border-b border-white/10 py-3 px-4 font-medium w-40">
              Span
            </th>
            <th className="whitespace-nowrap border-b border-white/10 py-3 pl-4 pr-6 font-medium">
              Body
            </th>
            <th
              className="border-b border-white/10 py-3 pr-6 w-10"
              aria-label="Expand"
            />
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const expanded = expandedId === log.id;
            const hasDetail =
              log.traceId ||
              log.spanId ||
              log.scopeName ||
              Object.keys(log.attributes).length > 0;
            return (
              <Fragment key={log.id}>
                <tr
                  className={`group border-t border-white/5 ${expanded ? "bg-white/[0.075]" : "hover:bg-white/[0.03]"}`}
                  onClick={() => {
                    if (!hasDetail) return;
                    const nextId = expanded ? null : log.id;
                    setExpandedId(nextId);
                  }}
                >
                  <td className="border-b border-white/5 py-2.5 pl-6 pr-4 text-sm tabular-nums text-zinc-500 align-top whitespace-nowrap">
                    {formatTimestamp(log.timestamp)}
                  </td>
                  <td className="border-b border-white/5 py-2.5 px-4 align-top">
                    <SeverityBadge severity={log.severityText} />
                  </td>
                  {!traceScoped && (
                    <td className="border-b border-white/5 py-2.5 px-4 text-sm align-top whitespace-nowrap">
                      <ServiceBadge
                        name={log.serviceName}
                        color={serviceColor(log.serviceName)}
                      />
                    </td>
                  )}
                  <td className="border-b border-white/5 py-2.5 px-4 text-sm tabular-nums text-zinc-500 align-top whitespace-nowrap">
                    {log.spanId ? (
                      log.spanId.slice(0, 12)
                    ) : (
                      <span className="text-zinc-700">-</span>
                    )}
                  </td>
                  <td className="border-b border-white/5 py-2.5 pl-4 pr-6 text-sm text-zinc-200 whitespace-pre-wrap break-words align-top">
                    {log.body}
                  </td>
                  <td className="border-b border-white/5 py-2.5 pr-6 text-right text-sm text-zinc-500 align-top">
                    {hasDetail && (
                      <span aria-hidden>{expanded ? "^" : "v"}</span>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr className="bg-zinc-950/80">
                    <td
                      colSpan={traceScoped ? 5 : 6}
                      className="border-b border-white/10 p-0"
                    >
                      <LogDetail
                        log={log}
                        traceScoped={traceScoped}
                        onSelectSpan={onSelectSpan}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LogDetail({
  log,
  traceScoped,
  onSelectSpan,
}: {
  log: LogRecord;
  traceScoped: boolean;
  onSelectSpan?: (spanId: string | null) => void;
}) {
  const attributes = Object.entries(log.attributes);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(24rem,1.25fr)] border-t border-white/[0.03] bg-zinc-950/70">
      <div className="px-6 py-4 border-b lg:border-b-0 lg:border-r border-white/10 min-h-44">
        <p className="text-sm text-zinc-500 mb-3">Context</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-zinc-500">Log ID</dt>
          <dd className="text-zinc-300 tabular-nums">{log.id}</dd>
          {log.scopeName && (
            <>
              <dt className="text-zinc-500">Scope</dt>
              <dd className="text-zinc-200 break-all">{log.scopeName}</dd>
            </>
          )}
          {log.traceId && (
            <>
              <dt className="text-zinc-500">Trace</dt>
              <dd className="text-accent break-all">{log.traceId}</dd>
            </>
          )}
          {log.spanId && (
            <>
              <dt className="text-zinc-500">Span</dt>
              <dd className="text-zinc-300 break-all">
                {log.spanId}
                {traceScoped && onSelectSpan && (
                  <button
                    type="button"
                    className="ml-2 rounded border border-white/10 bg-transparent px-2 py-0.5 text-sm text-zinc-400 hover:text-zinc-200 hover:border-white/20"
                    onClick={() => onSelectSpan(log.spanId)}
                  >
                    Open in trace
                  </button>
                )}
                {!traceScoped && log.traceId && (
                  <Link
                    to={`/trace/${log.traceId}${log.spanId ? `?span=${encodeURIComponent(log.spanId)}` : ""}`}
                    className="ml-2 rounded border border-white/10 bg-transparent px-2 py-0.5 text-sm text-zinc-400 no-underline hover:text-zinc-200 hover:border-white/20"
                  >
                    Open in trace
                  </Link>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="px-6 py-4 min-w-0">
        <p className="text-sm text-zinc-500 mb-3">
          Attributes ({attributes.length})
        </p>
        {attributes.length > 0 ? (
          <dl className="grid grid-cols-1 md:grid-cols-[minmax(10rem,18rem)_1fr] gap-x-8 gap-y-2 text-sm">
            {attributes.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-zinc-500 break-all">{key}</dt>
                <dd className="text-zinc-200 whitespace-pre-wrap break-words">
                  {value}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-zinc-600">No attributes</p>
        )}
      </div>
    </div>
  );
}
