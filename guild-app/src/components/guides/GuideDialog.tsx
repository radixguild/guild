"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import Link from "next/link";
import type { Guide } from "./guides";
import { AGENT_FAST_TRACK } from "./guides";

interface GuideDialogProps { guide: Guide; open: boolean; onClose: () => void; isAgent?: boolean; }

export function GuideDialog({ guide, open, onClose, isAgent = false }: GuideDialogProps) {
  const [step, setStep] = useState(0);
  const [roleIdx, setRoleIdx] = useState<number | null>(null);
  const roleEntries = guide.roles ? Object.entries(guide.roles) : null;
  const roleChosen = !roleEntries || roleIdx !== null;
  const roleStepList = roleChosen && roleIdx !== null && roleEntries ? roleEntries[roleIdx][1].steps : null;
  const effectiveSteps = roleStepList ? roleStepList.map(i => guide.steps[i]) : guide.steps;
  const totalSteps = effectiveSteps.length;
  const current = effectiveSteps[step];
  const isLast = step >= totalSteps - 1;
  const progress = totalSteps > 1 ? Math.round(((step + 1) / totalSteps) * 100) : 100;

  function handleNext() { if (isLast) { setStep(0); onClose(); } else setStep(prev => prev + 1); }
  function handlePrev() { setStep(prev => Math.max(0, prev - 1)); }
  function handleSkip() { setStep(0); onClose(); }

  // Agent fast-track
  if (isAgent && guide.agentFastTrack) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">{AGENT_FAST_TRACK.title}<Badge variant="secondary" className="text-[10px]">Agent</Badge></DialogTitle>
            <DialogDescription>{guide.description}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{AGENT_FAST_TRACK.body}</p>
          <div className="flex flex-col gap-2 mt-2">
            {AGENT_FAST_TRACK.links.map(link => (
              <Link key={link.href} href={link.href}><Button variant="outline" size="sm" className="justify-start w-full">{link.label}</Button></Link>
            ))}
          </div>
          <div className="flex justify-end mt-4"><Button variant="ghost" size="sm" onClick={onClose}>Skip</Button></div>
        </DialogContent>
      </Dialog>
    );
  }

  // Role picker
  if (roleEntries && !roleChosen) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{guide.title}</DialogTitle><DialogDescription>{guide.description}</DialogDescription></DialogHeader>
          <p className="text-sm font-medium mt-2">What brings you here?</p>
          <div className="flex flex-col gap-2 mt-1">
            {roleEntries.map(([key, role], i) => (
              <Button key={key} variant="outline" className="justify-start" onClick={() => setRoleIdx(i)}>{role.label}</Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Step walkthrough
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>{guide.title}</DialogTitle>
            {totalSteps > 1 && <span className="text-xs text-muted-foreground">{step + 1} of {totalSteps}</span>}
          </div>
          <DialogDescription>{guide.description}</DialogDescription>
        </DialogHeader>
        {totalSteps > 1 && <Progress value={progress} className="h-1.5" />}
        <div className="space-y-3 py-2">
          <h4 className="font-semibold text-sm">{current.title}</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{current.body}</p>
        </div>
        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            {step > 0 && <Button variant="ghost" size="sm" onClick={handlePrev}>Back</Button>}
            <Button variant="ghost" size="sm" onClick={handleSkip}>Skip all</Button>
          </div>
          <div className="flex gap-2">
            {current.actionHref ? (
              <Link href={current.actionHref} onClick={handleNext}><Button size="sm">{current.action || "Next"}</Button></Link>
            ) : (
              <Button size="sm" onClick={handleNext}>{current.action || (isLast ? "Done" : "Next")}</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
