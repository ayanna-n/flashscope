"use client";

import { useEffect, useRef } from "react";

type TradingViewChartProps = {
  ticker: string;
  interval?: string;
  height?: number;
};

export default function TradingViewChart({
  ticker,
  interval = "5",
  height = 500,
}: TradingViewChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartRef.current || !ticker) return;

    chartRef.current.innerHTML = "";

    const widgetContainer = document.createElement("div");
    widgetContainer.className = "tradingview-widget-container__widget";
    widgetContainer.style.height = `${height}px`;
    widgetContainer.style.width = "100%";

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;

    script.innerHTML = JSON.stringify({
      autosize: false,
      width: "100%",
      height,
      withdateranges: true,
      symbol: ticker,
      interval,
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "#1b0714",
      gridColor: "rgba(244, 114, 182, 0.08)",
      hide_side_toolbar: true,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_volume: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });

    chartRef.current.appendChild(widgetContainer);
    chartRef.current.appendChild(script);

    return () => {
      if (chartRef.current) {
        chartRef.current.innerHTML = "";
      }
    };
  }, [ticker, interval, height]);

  return (
    <div><p style={{fontSize:12,color:"#c9afc0",margin:"0 0 6px"}}>TradingView feed · may be delayed; see chart market-status indicator.</p><div
      ref={chartRef}
      className="tradingview-widget-container"
      style={{
        width: "100%",
        height: `${height}px`,
        overflow: "hidden",
        borderRadius: "12px",
      }}
    /></div>
  );
}