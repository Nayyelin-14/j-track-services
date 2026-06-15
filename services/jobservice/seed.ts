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
    { title: "Senior Software Engineer", description: "Build scalable microservices using Node.js and TypeScript. Lead architecture decisions.", salary: 145000, location: "San Francisco, CA", job_type: "Full-time" as const, openings: 3, role: "Backend", work_location: "Remote" as const, company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true },
    { title: "Product Manager", description: "Drive product roadmap for our flagship SaaS platform. Work with eng, design, and sales.", salary: 135000, location: "New York, NY", job_type: "Full-time" as const, openings: 1, role: "Product", work_location: "Hybrid" as const, company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true },
    { title: "Frontend Developer", description: "Develop responsive web apps using React and Next.js. Collaborate closely with UX team.", salary: 115000, location: "Austin, TX", job_type: "Full-time" as const, openings: 2, role: "Frontend", work_location: "Remote" as const, company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: true },
    { title: "DevOps Engineer", description: "Manage CI/CD pipelines, Kubernetes clusters, and AWS infrastructure.", salary: 140000, location: "Seattle, WA", job_type: "Contract" as const, openings: 2, role: "DevOps", work_location: "On-site" as const, company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: true },
    { title: "Data Analyst", description: "Analyze business metrics and build dashboards. SQL and Python expertise required.", salary: 105000, location: "Chicago, IL", job_type: "Full-time" as const, openings: 2, role: "Data", work_location: "Hybrid" as const, company_id: companies[2].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true },
    { title: "UI/UX Designer", description: "Create intuitive user interfaces and design systems for web and mobile products.", salary: 110000, location: "Los Angeles, CA", job_type: "Full-time" as const, openings: 1, role: "Design", work_location: "Remote" as const, company_id: companies[0].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true },
    { title: "Mobile Developer (iOS)", description: "Build native iOS applications using Swift. Experience with SwiftUI is a plus.", salary: 130000, location: "Miami, FL", job_type: "Full-time" as const, openings: 2, role: "Mobile", work_location: "On-site" as const, company_id: companies[2].company_id, posted_by_recruiter_id: recruiters[0].user_id, is_active: true },
    { title: "QA Automation Engineer", description: "Develop end-to-end test suites using Cypress and Playwright.", salary: 120000, location: "Denver, CO", job_type: "Contract" as const, openings: 1, role: "QA", work_location: "Remote" as const, company_id: companies[1].company_id, posted_by_recruiter_id: recruiters[1].user_id, is_active: false },
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
