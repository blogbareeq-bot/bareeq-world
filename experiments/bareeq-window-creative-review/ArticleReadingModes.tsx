"use client";
import React from "react";

type ModeProps = {
  onRead?: () => void;
  onListen?: () => void;
  onWindow?: () => void;
  windowResumeLabel?: string | null;
};

const FeatherIcon = () => (
  <svg viewBox="0 0 32 32" width="25" height="25" fill="none" aria-hidden="true">
    <path d="M23.5 5.5c-7.5 1.5-12.6 6.6-14.7 14.8l5.6-3.8 4.2-5.3-2.8 6.4-5.7 4.4" stroke="#C59B4A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8.7 21.3 6.5 26" stroke="#C59B4A" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
);

const EchoIcon = () => (
  <svg viewBox="0 0 32 32" width="25" height="25" fill="none" aria-hidden="true">
    <path d="M7 17v-2a9 9 0 0 1 18 0v2" stroke="#C59B4A" strokeWidth="1.8" strokeLinecap="round"/>
    <rect x="5" y="16" width="5" height="9" rx="2.2" stroke="#C59B4A" strokeWidth="1.8"/>
    <rect x="22" y="16" width="5" height="9" rx="2.2" stroke="#C59B4A" strokeWidth="1.8"/>
  </svg>
);

const WindowIcon = () => (
  <svg viewBox="0 0 36 36" width="27" height="27" fill="none" aria-hidden="true">
    <path d="M10 29V14c0-6 3.8-10 8-10s8 4 8 10v15" stroke="#E1B65E" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M13.5 29V15.5c0-3.8 2-6.6 4.5-6.6s4.5 2.8 4.5 6.6V29" stroke="#E1B65E" strokeWidth="1.5" opacity=".9"/>
    <path d="M10 29h16M18 9v20" stroke="#E1B65E" strokeWidth="1.5" opacity=".8"/>
    <path d="M18 2.3v-1M12.8 4.2l-1.1-1M23.2 4.2l1.1-1" stroke="#E1B65E" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
);

export default function ArticleReadingModes({ onRead, onListen, onWindow, windowResumeLabel }: ModeProps) {
  const base = "relative min-h-24 rounded-2xl px-3 py-4 border transition-all flex flex-col items-center justify-center gap-1.5";
  return (
    <div dir="rtl" className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="طرق قراءة المقال">
      <button type="button" onClick={onRead} className={`${base} bg-white/80 text-[#1E295D] border-[#1E295D]/10 hover:border-[#C59B4A]/35`}>
        <span className="w-11 h-11 rounded-xl grid place-items-center bg-[#FAF8F3] border border-[#C59B4A]/15"><FeatherIcon/></span>
        <strong className="text-base">سطور</strong>
        <small className="text-xs opacity-65">النص الكامل للمقال</small>
      </button>
      <button type="button" onClick={onListen} className={`${base} bg-white/80 text-[#1E295D] border-[#1E295D]/10 hover:border-[#C59B4A]/35`}>
        <span className="w-11 h-11 rounded-xl grid place-items-center bg-[#FAF8F3] border border-[#C59B4A]/15"><EchoIcon/></span>
        <strong className="text-base">صدى</strong>
        <small className="text-xs opacity-65">استمع إلى المقال مع النص</small>
      </button>
      <button type="button" onClick={onWindow} className={`${base} text-white border-[#D4AF37]/55 shadow-lg bg-[radial-gradient(circle_at_84%_20%,rgba(212,175,55,.16),transparent_30%),linear-gradient(145deg,#0C2C4A,#0D3D50_60%,#0C5B5D)]`}>
        {windowResumeLabel && <span className="absolute top-2 left-2 rounded-full bg-[#D4AF37] text-[#14243A] px-2 py-1 text-[10px] font-bold">{windowResumeLabel}</span>}
        <span className="w-11 h-11 rounded-xl grid place-items-center bg-black/10 border border-[#D4AF37]/20"><WindowIcon/></span>
        <strong className="text-base">نافذة</strong>
        <small className="text-xs text-white/70">{windowResumeLabel ? "تابع نافذتك من حيث توقفت" : "تجربة بصرية تفاعلية"}</small>
      </button>
    </div>
  );
}
