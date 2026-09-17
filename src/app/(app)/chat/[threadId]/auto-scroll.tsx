"use client";

import * as React from "react";

/** Scrolls itself into view whenever `dep` changes — drop at the bottom of the message list. */
export function AutoScroll({ dep }: { dep: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.scrollIntoView({ block: "end" });
  }, [dep]);
  return <div ref={ref} />;
}
