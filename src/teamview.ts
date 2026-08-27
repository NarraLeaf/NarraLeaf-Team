// What Team says about a project it has read, and about what it may be told to
// remember.
//
// Shapes and nothing else. They are filled in by the half that has the thing
// being described — a repository by src/projects/read.ts, the settings by
// src/view.ts — and handed to whoever has to answer a question out of them.
// Keeping the shape apart from the reading is what stops a second reader of this
// server growing a second account of it.
//
// Every field Team might fail to work out is optional, and an absent field is
// reported as unknown rather than as an error. This is the whole of the
// degradation rule: a project written by a newer Studio must show up with the
// parts Team understands and the word unknown for the rest.

/** What a revision history tells us, which does not depend on Studio at all. */
export interface RevisionView {
  /**
   * How many revisions there are, absent when Team has not counted them.
   *
   * Optional for the same reason everything else here is: a required number
   * has to be given a value even when nobody knows it, and the value that
   * gets given is zero — which reads as a project nobody has ever pushed to
   * rather than as a question Team did not ask.
   */
  readonly revisions?: number;
  /**
   * What the tip revision is, absent when Team has not read one.
   *
   * The only field here a client compares rather than displays: overlay records
   * name the revision they were written against, and this is what they are
   * measured against — see src/team/methods/overlay.ts. **Absent is "not read
   * yet", never "there are none"**, and a reader that confuses the two marks
   * everything stale for a minute after this server starts.
   */
  readonly head?: string;
  readonly branch?: string;
  readonly bytes?: number;
  readonly lastAt?: number;
  readonly lastBy?: string;
  readonly lastMessage?: string;
}

/**
 * What the project file tells us.
 *
 * `readable` is false when Team could not make sense of the file — most often
 * because it was written by a newer Studio. Everything else is then absent,
 * and `reason` is a sentence a person can act on. It is never an error: the
 * revision history above it is still true, and Team saying "unknown" is the
 * behaviour that keeps it from having to be upgraded in step with Studio.
 */
export interface ProjectFileView {
  readonly readable: boolean;
  readonly reason?: string;
  readonly title?: string;
  readonly stageWidth?: number;
  readonly stageHeight?: number;
  readonly scenes?: number;
  readonly assets?: number;
  readonly assetBytes?: number;
  readonly assetsByKind?: ReadonlyArray<{ readonly kind: string; readonly count: number; readonly bytes: number }>;
}

/**
 * What is said about a project nobody has read yet.
 *
 * An empty history rather than a zeroed one: absent draws as unknown, and a
 * project that has been worked on for months must not read as one nobody has
 * touched while the first clone of it is still running.
 *
 * It is here, beside the shapes it is made of, rather than beside any of the
 * surfaces that answer with it. More than one of them has to say this, and two
 * spellings would be two sentences about the same silence.
 */
export const NOT_READ_YET: { history: RevisionView; file: ProjectFileView } = {
  history: {},
  file: { readable: false, reason: "Team has not read this project's repository yet" },
};
