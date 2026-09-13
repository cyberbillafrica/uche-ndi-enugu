"use client";

import { useEffect, useState } from "react";
import { Calendar } from "lucide-react";

// State House of Assembly / Governorship Election
// Saturday, 6 February 2027 at 00:00 Nigeria time (WAT, UTC+1)
// Equivalent to 5 February 2027 at 23:00 UTC.
const ELECTION_DATE = new Date("2027-02-05T23:00:00.000Z").getTime();

type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

function calculateCountdown(): Countdown {
  const difference = Math.max(ELECTION_DATE - Date.now(), 0);

  return {
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),

    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),

    minutes: Math.floor((difference / (1000 * 60)) % 60),

    seconds: Math.floor((difference / 1000) % 60),
  };
}

function TimeBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-red-400 bg-green-700 px-1.5 py-2.5 text-center shadow-sm sm:bg-white/15">
      {" "}
      <div className="text-xl font-extrabold leading-none tracking-tight text-white sm:text-2xl md:text-3xl">
        {String(value).padStart(2, "0")}
      </div>
      <div className="mt-1.5 text-[8px] font-bold uppercase tracking-wider text-gray-200 sm:text-[9px]">
        {label}
      </div>
    </div>
  );
}

export default function ElectionCountdown() {
  /*
   * IMPORTANT:
   *
   * Do NOT calculate the countdown here.
   *
   * This initial value is identical on the server and browser,
   * which prevents the hydration mismatch.
   */
  const [countdown, setCountdown] = useState<Countdown | null>(null);

  const [mounted, setMounted] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    /*
     * We are now safely inside the browser.
     */
    setMounted(true);

    const updateCountdown = () => {
      setCountdown(calculateCountdown());
    };

    /*
     * Calculate immediately.
     */
    updateCountdown();

    /*
     * Continue updating every second.
     */
    const interval = window.setInterval(updateCountdown, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  /*
   * Before hydration has completed, render a static version.
   *
   * This exact same markup is rendered on server and browser,
   * so React has nothing to complain about.
   */
  const showLoading = !mounted || countdown === null;

  const electionReached =
    countdown !== null &&
    countdown.days === 0 &&
    countdown.hours === 0 &&
    countdown.minutes === 0 &&
    countdown.seconds === 0;

  return (
    <div
      className="
        relative z-30
        mx-4 mb-6 mt-5

        md:absolute
        md:right-4
        md:top-24
        md:mx-0
        md:mb-0
        md:mt-0
        md:w-[280px]
      "
    >
      <div
        className="
          mx-auto
          w-full
          max-w-[340px]
          rounded-2xl
          border
          border-white/20
          bg-apc-dark/95
          p-3
          text-green-500
          shadow-xl
          backdrop-blur-md

          md:mx-0
          md:p-4
        "
      >
        {/* Election Date */}
        <div className="mb-3 flex items-center gap-2.5 border-b border-white/10 pb-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-apc-green/20">
            <Calendar className="h-4 w-4 text-shadow-green-300" />
          </div>

          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-300">
              Election Date
            </p>

            <p className="text-xs font-bold text-shadow-green-300 sm:text-sm">
              Saturday, 6 February 2027
            </p>
          </div>
        </div>

        {/* Countdown Title */}
        <p className="mb-2.5 text-center text-[9px] font-semibold uppercase tracking-[0.18em] text-gray-300">
          Election Countdown
        </p>

        {/* Loading */}
        {showLoading ? (
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            <TimeBox value={0} label="Days" />
            <TimeBox value={0} label="Hours" />
            <TimeBox value={0} label="Min" />
            <TimeBox value={0} label="Sec" />
          </div>
        ) : electionReached ? (
          /* Election Day */
          <div className="rounded-xl bg-apc-green/20 px-3 py-4 text-center">
            <p className="text-sm font-bold text-apc-green">
              Election Day is Here!
            </p>
          </div>
        ) : (
          /* Live Countdown */
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            <TimeBox value={countdown.days} label="Days" />

            <TimeBox value={countdown.hours} label="Hours" />

            <TimeBox value={countdown.minutes} label="Min" />

            <TimeBox value={countdown.seconds} label="Sec" />
          </div>
        )}
      </div>
    </div>
  );
}
