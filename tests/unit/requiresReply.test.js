const { requiresReply } = require("../../src/ghost.js");

describe("requiresReply — no reply needed (→ false)", () => {
  // ── exact acks ──────────────────────────────────────────────────────────
  test.each([
    ["ok"], ["k"], ["kk"], ["okay"], ["okie"], ["sure"],
    ["yep"], ["yup"], ["yea"], ["yeah"], ["ye"], ["no"], ["nah"], ["nope"],
    ["got it"], ["gotcha"], ["gotchu"], ["noted"], ["copy"], ["roger"],
    ["will do"], ["on it"], ["done"], ["handled"], ["all good"],
    ["alright"], ["aight"], ["ight"], ["bet"], ["bet bet"], ["say less"],
    ["fs"], ["ofc"], ["of course"], ["absolutely"], ["for sure"],
    ["sounds good"], ["makes sense"], ["fair enough"], ["fair"], ["valid"],
    ["true"], ["facts"], ["word"], ["fr"], ["ik"], ["i know"], ["same"], ["mood"],
  ])('exact ack "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── exact acks with trailing punctuation ────────────────────────────────
  test.each([
    ["ok!"], ["okay!"], ["sure!"], ["will do!"], ["sounds good!"],
    ["got it!"], ["noted."], ["bet."], ["alright."], ["cool!"],
    ["thanks!"], ["ty!"], ["thx!"], ["np!"],
  ])('ack with trailing punct "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── gratitude ────────────────────────────────────────────────────────────
  test.each([
    ["thanks"], ["thx"], ["ty"], ["thank you"], ["thank u"],
    ["thanks a lot"], ["thanks so much"], ["thank you so much"],
    ["much appreciated"], ["appreciate it"], ["appreciate that"], ["appreciate you"],
    ["no worries"], ["no problem"], ["np"], ["no prob"], ["don't worry about it"],
  ])('gratitude "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── short fuzzy gratitude (≤20 chars) ───────────────────────────────────
  test.each([
    ["thanks man"], ["ty bro"], ["thanks dude"], ["thx a lot"],
    ["thank you!"], ["thanks!!"], ["thanks lol"],
  ])('fuzzy gratitude "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── short fuzzy ok/will-do combos ───────────────────────────────────────
  test.each([
    ["ok sounds good"], ["ok will do"], ["ok got it"], ["okay cool"],
    ["got it thanks"], ["got it ok"], ["sounds good ok"],
    ["k sounds good"], ["k thanks"],
  ])('fuzzy ok-combo "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── short fuzzy yeah/nah ─────────────────────────────────────────────────
  test.each([
    ["yeah for sure"], ["yep sounds good"], ["yea ok"], ["nah im good"],
    ["nah its fine"], ["yeah that works"], ["yep got it"],
  ])('fuzzy yeah/nah "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── conversational closers ───────────────────────────────────────────────
  test.each([
    ["bye"], ["byee"], ["byeee"], ["later"], ["laters"], ["cya"],
    ["see ya"], ["see you"], ["see you later"], ["talk later"], ["ttyl"],
    ["ttys"], ["talk soon"], ["speak soon"],
    ["good night"], ["gnight"], ["gn"], ["night"],
    ["good morning"], ["gm"], ["morning"],
    ["on my way"], ["omw"], ["be there soon"], ["almost there"],
    ["5 min"], ["10 min"], ["be right there"], ["brt"],
    ["brb"], ["back"], ["im back"], ["i'm back"],
  ])('closer "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── short fuzzy closers ──────────────────────────────────────────────────
  test.each([
    ["bye!", "bye man", "later bro", "cya tomorrow"],
    ["gn man"], ["see ya bro"], ["ttyl!"],
  ].flat())('fuzzy closer "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── emoji only ───────────────────────────────────────────────────────────
  test.each([
    ["👍"], ["👍🏻"], ["❤️"], ["😂"], ["💀"], ["🙏"], ["🫡"], ["👌"],
    ["😂😭💀"], ["🤣🤣"],
  ])('emoji-only "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── iMessage tapback reactions ───────────────────────────────────────────
  test.each([
    ['Liked "see you at 3"'],
    ['Loved "hey are you coming"'],
    ['Disliked "let\'s do Friday"'],
    ['Emphasized "on my way"'],
    ['Questioned "what time?"'],
    ['Laughed at "lol that\'s wild"'],
  ])('tapback reaction "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── empty / whitespace ───────────────────────────────────────────────────
  test.each([[""], ["   "], ["\t"], ["\n"]])('empty "%s" → false', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });

  // ── sensitive content — ghost should stay out ────────────────────────────
  test.each([
    ["she died this morning"],
    ["grandma passed away yesterday"],
    ["I'm at the hospital it's an emergency"],
    ["he was diagnosed with cancer"],
    ["I want to kill myself"],
    ["we broke up last night"],
    ["I think he's cheating on me"],
    ["I just got fired"],
    ["they arrested him"],
    ["I love you"],
    ["i love you so much"],
  ])('sensitive "%s" → false (ghost stays out)', (msg) => {
    expect(requiresReply(msg)).toBe(false);
  });
});

describe("requiresReply — reply needed (→ true)", () => {
  test.each([
    // questions
    ["hey what are you doing tonight"],
    ["are you free saturday"],
    ["can you pick me up?"],
    ["what time works for you"],
    ["did you see what happened"],
    ["yo we going out?"],
    ["what do you think about that"],
    ["can you help me with this"],
    ["when are you getting here"],
    ["you coming to the party or nah"],
    // statements that need engagement
    ["dude you gotta see this"],
    ["just got back from the gym"],
    ["bro something crazy happened"],
    ["i need to tell you something important"],
    ["we should hang out this weekend"],
    ["let me know what time works"],
    ["hit me up when you're free"],
    // questions seeking confirmation
    ["you okay with that?"],
    ["is that cool with you?"],
    ["does that sound good to you?"],
    // longer messages
    ["hey man haven't heard from you in a while, you doing alright?"],
    ["dude are you coming to Emmet's thing on Friday or are you busy"],
  ])('reply needed "%s" → true', (msg) => {
    expect(requiresReply(msg)).toBe(true);
  });
});
