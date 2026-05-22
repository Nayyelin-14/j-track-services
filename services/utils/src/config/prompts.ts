export const careerGuidancePrompt = (skills: string) => `
You are a career guidance expert. Based on the user's skills, generate career guidance.

User skills: ${skills}

Respond ONLY with a valid JSON object. No markdown, no code blocks, no extra text — just raw JSON.

The JSON object should have the following structure:
{
  "summary": "A brief, encouraging summary of the user's skill set and their general job title.",
  "jobOptions": [
    {
      "title": "The name of the job role.",
      "category": "The industry or field this role belongs to (e.g. Web Development, Data Science, DevOps).",
      "description": "A short description of what this role involves.",
      "matchScore": "A percentage (0-100) indicating how well the user's skills match this role.",
      "responsibilities": [
        "A key day-to-day responsibility for this role.",
        "Another responsibility."
      ],
      "requiredSkills": ["skill1", "skill2"],
      "missingSkills": ["skill3", "skill4"]
    }
  ],
  "learningPath": [
    {
      "skill": "The name of the skill to learn.",
      "category": "The area this skill belongs to (e.g. Frontend, Backend, Cloud, AI).",
      "reason": "Why this skill is important for their career growth.",
      "whyItMatters": "A personalized explanation of how learning this skill will benefit the user specifically based on their current skill set.",
      "resources": ["resource1", "resource2"]
    }
  ],
  "topRecommendation": {
    "title": "The single best job role for this user.",
    "reason": "Why this is the best fit based on their skills."
  }
}
`;

export const prepareResumeText = (rawText: string): string => {
  return rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[^\x20-\x7E\n]/g, " ")
    .trim();
};

export const fullResumePrompt = (resumeText: string): string =>
  `
You are an expert ATS (Applicant Tracking System) engine combined with a senior technical recruiter with 15+ years of experience.
Respond with ONLY valid JSON. No markdown, no explanation, no extra text. Just raw JSON.

CRITICAL PARSING INSTRUCTIONS:
- This text was extracted from a PDF and may have broken formatting
- Text from multi-column layouts may appear merged, reordered, or jumbled
- Skills may appear next to project names instead of in a skills section
- Section headings may appear anywhere in the text
- You MUST intelligently reconstruct the resume content regardless of text order
- Extract ALL technical skills, tools, and technologies mentioned ANYWHERE in the text
- Infer context from surrounding words even if layout is broken

RESUME TEXT:
"""
${resumeText}
"""

ATS SCORING RULES (total 100pts):
- formatting (20pts): Single-column layout, standard section headings, no tables/images/text boxes, ATS-parseable structure. Deduct points for multi-column layouts, graphics, or non-standard fonts.
- keywords (25pts): Relevant job title keywords, technical skills, action verbs (Led, Built, Designed, Implemented, Improved, Optimized), measurable achievements with numbers/percentages.
- experience (25pts): Reverse chronological order, clear company+title+dates, quantified impact per role, no unexplained gaps. Deduct for missing dates or vague descriptions.
- education (10pts): Degree name, institution, graduation year clearly stated.
- skills (10pts): Dedicated skills section with explicit hard skills. Deduct for vague soft-skill-only sections.
- achievements (10pts): Quantified results present (e.g. "reduced load time by 40%", "managed 5-person team", "served 1000+ users").

Respond with EXACTLY this JSON structure, no deviations:
{
  "atsScore": {
    "overall": 0,
    "breakdown": {
      "formatting": { "score": 0, "max": 20, "reason": "" },
      "keywords": { "score": 0, "max": 25, "reason": "" },
      "experience": { "score": 0, "max": 25, "reason": "" },
      "education": { "score": 0, "max": 10, "reason": "" },
      "skills": { "score": 0, "max": 10, "reason": "" },
      "achievements": { "score": 0, "max": 10, "reason": "" }
    }
  },
  "candidateProfile": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "currentLevel": "",
    "primaryDomain": "",
    "yearsOfExperience": 0,
    "currentTitle": ""
  },
  "summary": "",
  "detectedSkills": {
    "technical": [],
    "soft": [],
    "tools": [],
    "certifications": [],
    "languages": []
  },
  "missingKeywords": [],
  "suggestedRoles": [],
  "strengths": [{ "title": "", "description": "" }],
  "improvements": [{ "priority": "", "section": "", "issue": "", "suggestion": "", "atsImpact": "" }],
  "quickWins": [{ "action": "", "impact": "" }]
}

STRICT RULES:
- overall = exact sum of all 6 breakdown scores
- currentLevel: "entry" (0-2 yrs) | "mid" (2-5 yrs) | "senior" (5-10 yrs) | "lead" (8+ yrs managing) | "executive" (director+)
- detectedSkills.technical: every programming language, framework, library found ANYWHERE in text
- detectedSkills.tools: every tool, platform, service, database found ANYWHERE in text
- detectedSkills.languages: spoken/written human languages only (English, Thai, etc)
- strengths: max 5, must cite specific evidence from resume text, not generic praise
- improvements: max 6, sorted high→medium→low, atsImpact must explain exactly how it hurts ATS ranking
- quickWins: max 3, each completable in under 10 minutes, must have immediate measurable ATS impact
- missingKeywords: important industry keywords for the candidate's domain that are absent from resume
- suggestedRoles: max 5, job titles this resume would realistically match in ATS keyword search
- Be precise and honest — base every score and comment on actual resume content only
`.trim();
