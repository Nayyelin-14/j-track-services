import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DB_URL! } },
});

async function seed() {
  console.log("Seeding database...");

  await prisma.$executeRawUnsafe("TRUNCATE TABLE applications, jobs, companies, user_skills, skills, users CASCADE");
  console.log("Cleared existing data");

  const passwordHash = await bcrypt.hash("password123", 10);

  const recruiters = await Promise.all([
    prisma.user.create({
      data: {
        name: "Alice Johnson",
        email: "alice@techcorp.com",
        password: passwordHash,
        phone_number: "555-0101",
        role: "recruiter",
        bio: "HR Manager at TechCorp",
      },
    }),
    prisma.user.create({
      data: {
        name: "Bob Smith",
        email: "bob@startupxyz.com",
        password: passwordHash,
        phone_number: "555-0102",
        role: "recruiter",
        bio: "Talent Lead at StartupXYZ",
      },
    }),
  ]);
  console.log(`Created ${recruiters.length} recruiters`);

  const jobseekersData = [
    { name: "Charlie Brown", email: "charlie@email.com", phone: "555-0201", bio: "Frontend dev with 3 years experience", resume: "https://res.cloudinary.com/demo/resume1.pdf", resume_public_id: "resumes/charlie" },
    { name: "Diana Prince", email: "diana@email.com", phone: "555-0202", bio: "Full-stack engineer", resume: "https://res.cloudinary.com/demo/resume2.pdf", resume_public_id: "resumes/diana" },
    { name: "Evan Wright", email: "evan@email.com", phone: "555-0203", bio: "Backend specialist", resume: "https://res.cloudinary.com/demo/resume3.pdf", resume_public_id: "resumes/evan" },
    { name: "Fiona Gallagher", email: "fiona@email.com", phone: "555-0204", bio: "DevOps engineer", resume: "https://res.cloudinary.com/demo/resume4.pdf", resume_public_id: "resumes/fiona" },
    { name: "George Miller", email: "george@email.com", phone: "555-0205", bio: "Product designer", resume: "https://res.cloudinary.com/demo/resume5.pdf", resume_public_id: "resumes/george" },
    { name: "Hannah Lee", email: "hannah@email.com", phone: "555-0206", bio: "Data scientist", resume: "https://res.cloudinary.com/demo/resume6.pdf", resume_public_id: "resumes/hannah" },
    { name: "Ian Clark", email: "ian@email.com", phone: "555-0207", bio: "Mobile developer", resume: "https://res.cloudinary.com/demo/resume7.pdf", resume_public_id: "resumes/ian" },
    { name: "Julia Roberts", email: "julia@email.com", phone: "555-0208", bio: "QA engineer", resume: "https://res.cloudinary.com/demo/resume8.pdf", resume_public_id: "resumes/julia" },
  ];

  const jobseekers = [];
  for (const js of jobseekersData) {
    const user = await prisma.user.create({
      data: {
        name: js.name,
        email: js.email,
        password: passwordHash,
        phone_number: js.phone,
        role: "jobseeker",
        bio: js.bio,
        resume: js.resume,
        resume_public_id: js.resume_public_id,
      },
    });
    jobseekers.push(user);
  }
  console.log(`Created ${jobseekers.length} jobseekers`);

  const companiesData = [
    { name: "TechCorp", description: "Leading enterprise technology solutions provider specializing in cloud infrastructure and SaaS products.", website: "https://techcorp.example.com", logo: "https://res.cloudinary.com/demo/logo1.png", logo_public_id: "logos/techcorp", recruiter_id: recruiters[0].user_id },
    { name: "StartupXYZ", description: "Fast-growing fintech startup revolutionizing digital payments for small businesses.", website: "https://startupxyz.example.com", logo: "https://res.cloudinary.com/demo/logo2.png", logo_public_id: "logos/startupxyz", recruiter_id: recruiters[1].user_id },
    { name: "GlobalSystems", description: "Worldwide logistics and supply chain management platform serving enterprise clients.", website: "https://globalsystems.example.com", logo: "https://res.cloudinary.com/demo/logo3.png", logo_public_id: "logos/globalsystems", recruiter_id: recruiters[0].user_id },
  ];

  const companies = [];
  for (const c of companiesData) {
    const company = await prisma.company.create({ data: c });
    companies.push(company);
  }
  console.log(`Created ${companies.length} companies`);

  const jobsData = [
    {
      title: "Senior Software Engineer",
      description: "Build scalable microservices using Node.js and TypeScript. Lead architecture decisions.",
      salary: 145000, location: "San Francisco, CA", job_type: "Full_time" as const,
      openings: 3, role: "Backend", work_location: "Remote" as const,
      company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true,
      details: {
        responsibilities: "Design and implement scalable microservices architecture using Node.js and TypeScript. Lead code reviews and mentor junior engineers. Collaborate with product and DevOps teams to deliver features end-to-end.",
        required_skills: "7+ years of software engineering experience. Strong proficiency in Node.js, TypeScript, PostgreSQL, and REST/GraphQL APIs. Experience with microservices architecture and message queues (RabbitMQ, Kafka).",
        preferred_skills: "Experience with NestJS, gRPC, event sourcing, and CQRS patterns. Contributions to open source projects.",
        tech_stack: ["Node.js", "TypeScript", "PostgreSQL", "Redis", "Kafka", "Docker", "Kubernetes", "AWS"],
        experience_years: 7,
        education: "Bachelor's degree in Computer Science or related field",
        certifications: [],
        languages: ["English"],
        benefits: "Competitive salary, equity package, 401k matching, unlimited PTO, health/dental/vision insurance, annual learning budget, remote work stipend",
        visa_sponsorship: true,
        working_hours: "Flexible, core hours 10am-3pm PT",
        team_structure: "8 engineers (4 backend, 2 frontend, 2 DevOps), 1 EM, 1 PM",
        reporting_line: "Engineering Manager",
        career_growth: "Senior -> Staff -> Principal Engineer track. Opportunities to lead technical initiatives and mentor teams.",
        interview_process: "1. Phone screen (30min) 2. Technical coding (60min) 3. System design (60min) 4. Behavioral + cross-team (45min)",
      },
    },
    {
      title: "Product Manager",
      description: "Drive product roadmap for our flagship SaaS platform. Work with eng, design, and sales.",
      salary: 135000, location: "New York, NY",       job_type: "Full_time" as const,
      openings: 1, role: "Product", work_location: "Hybrid" as const,
      company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true,
      details: {
        responsibilities: "Define and communicate product vision and strategy. Own the product roadmap and prioritize features based on customer impact and business value. Collaborate with engineering, design, and go-to-market teams.",
        required_skills: "5+ years of product management experience in SaaS/B2B. Strong analytical skills with experience using data to drive decisions. Excellent cross-functional communication.",
        preferred_skills: "Experience with AI/ML products. Technical background or CS degree. Familiarity with agile methodologies.",
        tech_stack: ["Jira", "Confluence", "Amplitude", "Mixpanel", "SQL"],
        experience_years: 5,
        education: "Bachelor's degree required, MBA preferred",
        certifications: ["Certified Scrum Product Owner (CSPO)"],
        languages: ["English"],
        benefits: "Competitive salary, performance bonuses, 401k, health insurance, commuter benefits, gym membership",
        visa_sponsorship: false,
        working_hours: "9:00 - 17:00 ET, hybrid (3 days in office)",
        team_structure: "Works with 3 engineering squads (15 engineers total), 2 designers, 1 data analyst",
        reporting_line: "VP of Product",
        career_growth: "Product Manager -> Senior PM -> Director of Product",
        interview_process: "1. Phone screen 2. Product case study 3. Strategic thinking 4. Cross-functional panel 5. Executive interview",
      },
    },
    {
      title: "Frontend Developer",
      description: "Develop responsive web apps using React and Next.js. Collaborate closely with UX team.",
      salary: 115000, location: "Austin, TX", job_type: "Full_time" as const,
      openings: 2, role: "Frontend", work_location: "Remote" as const,
      company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: true,
      details: {
        responsibilities: "Build and maintain responsive web applications using React and Next.js. Implement pixel-perfect UI designs and ensure cross-browser compatibility. Optimize application performance and accessibility.",
        required_skills: "3+ years of frontend development experience. Proficiency in React, TypeScript, CSS/Sass, and responsive design principles. Experience with REST API integration.",
        preferred_skills: "Experience with Next.js, Tailwind CSS, Storybook, and testing frameworks (Jest, Cypress). Knowledge of web accessibility (WCAG).",
        tech_stack: ["React", "Next.js", "TypeScript", "Tailwind CSS", "Storybook", "Jest", "Cypress"],
        experience_years: 3,
        education: "Bachelor's degree in Computer Science or equivalent experience",
        certifications: [],
        languages: ["English"],
        benefits: "Competitive salary, equity, 401k, health insurance, remote work equipment budget, flexible hours",
        visa_sponsorship: false,
        working_hours: "Flexible, async-first culture",
        team_structure: "6 frontend engineers, 3 designers, 1 UX researcher",
        reporting_line: "Frontend Tech Lead",
        career_growth: "Frontend Developer -> Senior -> Staff -> Frontend Architect",
        interview_process: "1. Portfolio review 2. Coding challenge (take-home) 3. Technical interview 4. Culture fit",
      },
    },
    {
      title: "DevOps Engineer",
      description: "Manage CI/CD pipelines, Kubernetes clusters, and AWS infrastructure.",
      salary: 140000, location: "Seattle, WA", job_type: "Contract" as const,
      openings: 2, role: "DevOps", work_location: "On_site" as const,
      company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: true,
      details: {
        responsibilities: "Design, implement, and maintain CI/CD pipelines. Manage Kubernetes clusters across multiple environments. Automate infrastructure provisioning using IaC tools. Monitor system health and respond to incidents.",
        required_skills: "5+ years of DevOps/SRE experience. Strong knowledge of Kubernetes, Docker, Terraform, and CI/CD tools. Experience with AWS or GCP at scale.",
        preferred_skills: "Experience with Helm, ArgoCD, Prometheus, Grafana, and service mesh (Istio). Programming skills in Go or Python.",
        tech_stack: ["Kubernetes", "Docker", "Terraform", "AWS", "Helm", "ArgoCD", "Prometheus", "Grafana", "GitHub Actions"],
        experience_years: 5,
        education: "Bachelor's degree in CS or equivalent experience",
        certifications: ["AWS Certified DevOps Engineer", "CKA (Certified Kubernetes Administrator)"],
        languages: ["English"],
        benefits: "Competitive contract rate, equipment budget, flexible schedule, opportunity for full-time conversion",
        visa_sponsorship: true,
        working_hours: "9:00 - 17:00 PT, on-call rotation 1 week/month",
        team_structure: "5 DevOps engineers, 1 SRE Manager",
        reporting_line: "DevOps Team Lead",
        career_growth: "DevOps Engineer -> Senior -> Staff -> Platform Engineering Lead",
        interview_process: "1. Technical phone screen 2. Hands-on infrastructure challenge 3. System design 4. Team interview",
      },
    },
    {
      title: "Data Analyst",
      description: "Analyze business metrics and build dashboards. SQL and Python expertise required.",
      salary: 105000, location: "Chicago, IL", job_type: "Full_time" as const,
      openings: 2, role: "Data", work_location: "Hybrid" as const,
      company_id: companies[2].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true,
      details: {
        responsibilities: "Analyze large datasets to uncover business insights. Build and maintain dashboards in Looker/Tableau. Partner with product, marketing, and finance teams on data-driven decisions. Design and evaluate A/B tests.",
        required_skills: "3+ years of data analysis experience. Advanced SQL skills. Proficiency in Python for data analysis (pandas, numpy). Experience with data visualization tools.",
        preferred_skills: "Experience with dbt, Airflow, and data warehousing concepts. Knowledge of statistical analysis methods.",
        tech_stack: ["SQL", "Python", "Looker", "Tableau", "dbt", "Snowflake", "Airflow"],
        experience_years: 3,
        education: "Bachelor's degree in Statistics, Mathematics, Economics, or related field",
        certifications: [],
        languages: ["English"],
        benefits: "Competitive salary, annual bonus, 401k, health insurance, professional development budget, hybrid work flexibility",
        visa_sponsorship: false,
        working_hours: "9:00 - 17:30 CT, hybrid (Tues-Thurs in office)",
        team_structure: "4 data analysts, 2 data engineers, 1 analytics manager",
        reporting_line: "Analytics Manager",
        career_growth: "Data Analyst -> Senior Analyst -> Analytics Manager -> Director of Data",
        interview_process: "1. SQL assessment 2. Case study presentation 3. Python technical 4. Behavioral interview",
      },
    },
    {
      title: "UI/UX Designer",
      description: "Create intuitive user interfaces and design systems for web and mobile products.",
      salary: 110000, location: "Los Angeles, CA", job_type: "Full_time" as const,
      openings: 1, role: "Design", work_location: "Remote" as const,
      company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true,
      details: {
        responsibilities: "Design intuitive user interfaces for web and mobile products. Create and maintain design systems and component libraries. Conduct user research and usability testing. Collaborate closely with product managers and engineers.",
        required_skills: "4+ years of UI/UX design experience. Strong portfolio demonstrating user-centered design process. Proficiency in Figma and prototyping tools. Understanding of design systems and accessibility.",
        preferred_skills: "Experience with motion design, illustration skills, familiarity with HTML/CSS, experience designing for B2B SaaS.",
        tech_stack: ["Figma", "Sketch", "Principle", "Protopie", "Maze", "UsabilityHub"],
        experience_years: 4,
        education: "Bachelor's degree in Design, HCI, or related field",
        certifications: [],
        languages: ["English"],
        benefits: "Competitive salary, equity, 401k matching, health insurance, home office stipend, annual design conference budget",
        visa_sponsorship: false,
        working_hours: "Flexible, core hours 10am-3pm PT",
        team_structure: "5 designers, 1 design manager, embedded with product teams",
        reporting_line: "Design Manager",
        career_growth: "Designer -> Senior Designer -> Design Lead -> Design Director",
        interview_process: "1. Portfolio review 2. Design challenge (whiteboard) 3. Cross-functional interview 4. Executive review",
      },
    },
    {
      title: "Mobile Developer (iOS)",
      description: "Build native iOS applications using Swift. Experience with SwiftUI is a plus.",
      salary: 130000, location: "Miami, FL", job_type: "Full_time" as const,
      openings: 2, role: "Mobile", work_location: "On_site" as const,
      company_id: companies[2].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true,
      details: {
        responsibilities: "Develop and maintain native iOS applications using Swift and SwiftUI. Implement new features following MVVM architecture. Write unit and UI tests. Collaborate with backend engineers on API design.",
        required_skills: "4+ years of iOS development experience. Strong knowledge of Swift, SwiftUI, UIKit, and Combine. Experience with Core Data, networking layer, and App Store submission process.",
        preferred_skills: "Experience with XCTest, XCUITest, CI/CD for mobile (Bitrise, GitHub Actions), and modular architecture. Knowledge of RxSwift or async/await.",
        tech_stack: ["Swift", "SwiftUI", "UIKit", "Combine", "Core Data", "XCTest", "XCUITest", "GitHub Actions"],
        experience_years: 4,
        education: "Bachelor's degree in Computer Science or equivalent",
        certifications: [],
        languages: ["English", "Spanish"],
        benefits: "Competitive salary, equity, 401k, health insurance, relocation assistance, on-site gym, free lunch",
        visa_sponsorship: true,
        working_hours: "9:00 - 18:00 ET, on-site",
        team_structure: "4 iOS engineers, 3 Android engineers, 1 mobile tech lead",
        reporting_line: "Mobile Tech Lead",
        career_growth: "iOS Developer -> Senior -> Staff -> Mobile Architect",
        interview_process: "1. Phone screen 2. Coding challenge (Swift) 3. System design 4. On-site interviews (x4)",
      },
    },
    {
      title: "QA Automation Engineer",
      description: "Develop end-to-end test suites using Cypress and Playwright.",
      salary: 120000, location: "Denver, CO", job_type: "Contract" as const,
      openings: 1, role: "QA", work_location: "Remote" as const,
      company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: false,
      details: {
        responsibilities: "Design and implement automated test frameworks for web and API testing. Write E2E tests using Cypress and Playwright. Integrate tests into CI/CD pipeline. Report and track defects, collaborate with developers on root cause analysis.",
        required_skills: "3+ years of QA automation experience. Proficiency in JavaScript/TypeScript. Experience with Cypress or Playwright. Knowledge of CI/CD integration and version control (Git).",
        preferred_skills: "Experience with API testing (Postman, Supertest), performance testing (k6, Lighthouse), and mobile testing.",
        tech_stack: ["Cypress", "Playwright", "TypeScript", "GitHub Actions", "Postman", "k6", "Selenium"],
        experience_years: 3,
        education: "Bachelor's degree in CS or equivalent experience",
        certifications: ["ISTQB Certified Tester"],
        languages: ["English"],
        benefits: "Competitive contract rate, remote-first culture, flexible hours, equipment provided",
        visa_sponsorship: false,
        working_hours: "Flexible, overlap with 9am-3pm MT required",
        team_structure: "3 QA engineers (2 automation, 1 manual), embedded across engineering squads",
        reporting_line: "QA Lead",
        career_growth: "QA Engineer -> Senior QA -> QA Lead -> Quality Engineering Manager",
        interview_process: "1. Technical phone screen 2. Take-home automation challenge 3. Pair programming 4. Team fit",
      },
    },
  ];

  const jobs = [];
  for (const j of jobsData) {
    const job = await prisma.job.create({ data: j });
    jobs.push(job);
  }
  console.log(`Created ${jobs.length} jobs`);

  const skillNames = ["JavaScript", "TypeScript", "React", "Node.js", "Python", "SQL", "AWS", "Docker", "Kubernetes", "GraphQL"];
  const skills = [];
  for (const name of skillNames) {
    const skill = await prisma.skill.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    skills.push(skill);
  }
  console.log(`Created ${skills.length} skills`);

  let userSkillCount = 0;
  for (const user of jobseekers) {
    const count = 2 + Math.floor(Math.random() * 4);
    const shuffled = [...skills].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, count);
    for (const s of selected) {
      await prisma.userSkill.upsert({
        where: { user_id_skill_id: { user_id: user.user_id, skill_id: s.skill_id } },
        create: { user_id: user.user_id, skill_id: s.skill_id },
        update: {},
      });
      userSkillCount++;
    }
  }
  console.log(`Assigned ${userSkillCount} user skills`);

  const activeJobs = jobs.filter((j) => j.is_active);
  let appCount = 0;

  for (let i = 0; i < 15; i++) {
    const job = activeJobs[Math.floor(Math.random() * activeJobs.length)];
    const applicant = jobseekers[Math.floor(Math.random() * jobseekers.length)];

    const r = Math.random();
    const status = r > 0.85 ? "Hired" : r > 0.6 ? "Rejected" : "Submitted";
    const subscribed = Math.random() > 0.5;

    try {
      await prisma.application.create({
        data: {
          job_id: job.job_id,
          applicant_id: applicant.user_id,
          applicant_email: applicant.email,
          status: status as any,
          resume: applicant.resume ?? undefined,
          subscribed,
        },
      });
      appCount++;
    } catch (err: any) {
      if (err.code === "P2002") {
        console.log(`Skipped duplicate: user ${applicant.user_id} -> job ${job.job_id}`);
      } else {
        throw err;
      }
    }
  }
  console.log(`Created ${appCount} applications`);

  console.log("\nSeed complete!");
  console.log("Test logins (password: password123):");
  console.log("  Recruiter: alice@techcorp.com | bob@startupxyz.com");
  console.log("  Jobseeker: charlie@email.com  | diana@email.com | evan@email.com ...");

  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
