// Fixture-based check of the Gradescope HTML parsers. Run: npx esbuild scripts/test-gradescope-html.ts --bundle --platform=node --format=esm --outfile=/tmp/gs-test.mjs && node /tmp/gs-test.mjs
import { parseGradescopeAssignments, parseGradescopeCourses } from '../src/main/school/gradescopeHtml'

const dashboard = `
<div id="account-show">
  <h2 class="pageHeading">Your Courses</h2>
  <div class="courseList">
    <div class="courseList--term">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/900001">
        <h3 class="courseBox--shortname">STAT 390 A</h3>
        <div class="courseBox--name">Statistical Methods in Engineering &amp; Science</div>
        <div class="courseBox--assignments">4 assignments</div>
      </a>
      <a class="courseBox" href="/courses/900002">
        <h3 class="courseBox--shortname">AMATH 351 B - AU26</h3>
        <div class="courseBox--name">Intro to ODEs</div>
      </a>
      <a class="courseBox courseBox--new" href="/courses/new">Create a course</a>
    </div>
    <div class="courseList--term">Spring 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/800001">
        <h3 class="courseBox--shortname">CSE 143</h3>
      </a>
    </div>
  </div>
</div>`

const coursePage = `
<table id="assignments-student-table" class="table">
  <thead><tr role="row"><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Released</th></tr></thead>
  <tbody>
    <tr role="row">
      <th class="table--primaryLink"><button class="js-submitAssignment" data-assignment-id="5001" data-post-url="/courses/900001/assignments/5001/submissions">Homework 2</button></th>
      <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
      <td><div class="submissionTimeChart">
        <time class="submissionTimeChart--releaseDate" datetime="2026-09-29 00:00:00 -0700">Sep 29</time>
        <time class="submissionTimeChart--dueDate" datetime="2026-10-06 21:10:00 -0700">Oct 06 at 9:10PM</time>
        <time class="submissionTimeChart--dueDate" datetime="2026-10-08 21:10:00 -0700">Oct 08 at 9:10PM</time>
      </div></td>
    </tr>
    <tr role="row">
      <th class="table--primaryLink"><a href="/courses/900001/assignments/5000/submissions/777">Homework 1</a></th>
      <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
      <td><div class="submissionTimeChart"><time class="submissionTimeChart--dueDate" datetime="2026-09-29 21:10:00 -0700">Sep 29</time></div></td>
    </tr>
    <tr role="row">
      <th class="table--primaryLink"><a href="/courses/900001/assignments/4999/submissions/700">Quiz 0</a></th>
      <td class="submissionStatus"><div class="submissionStatus--score">9.0 / 10.0</div></td>
      <td><div class="submissionTimeChart"><time class="submissionTimeChart--dueDate" datetime="2026-09-25 23:59:00 -0700">Sep 25</time></div></td>
    </tr>
    <tr role="row">
      <th class="table--primaryLink">Midterm (no upload)</th>
      <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
      <td><div class="submissionTimeChart"><time class="submissionTimeChart--dueDate" datetime="2026-11-03 10:30:00 -0800">Nov 03</time></div></td>
    </tr>
    <tr role="row" class="dropzonePreview--fileNameHeader"><td colspan="3"></td></tr>
  </tbody>
</table>`

let failures = 0
const expect = (label: string, cond: boolean): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
  if (!cond) failures++
}

const courses = parseGradescopeCourses(dashboard, new Date('2026-10-04T12:00:00'))
console.log(courses)
expect('two current-term courses, past term and "new" card skipped', courses.length === 2)
expect('section letter dropped', courses[0]?.course === 'STAT 390')
expect('term suffix dropped', courses[1]?.course === 'AMATH 351')

const fallback = parseGradescopeCourses(dashboard.replace('Fall 2026', 'Term X'), new Date('2026-10-04T12:00:00'))
expect('unknown term label falls back to the first block', fallback.length === 2)

const empty = parseGradescopeCourses('<html><body>Log in</body></html>')
expect('login page yields no courses', empty.length === 0)

const a = parseGradescopeAssignments(coursePage, '900001')
console.log(a)
expect('three assignments parsed (header, no-id row, trailer skipped)', a.length === 3)
const hw2 = a.find((x) => x.id === '5001')
expect('button row: id from data-assignment-id, not submitted', hw2?.name === 'Homework 2' && hw2.submitted === false)
expect('first due date wins over late due date', hw2?.due.day === '2026-10-06' && hw2.due.time === '21:10')
const hw1 = a.find((x) => x.id === '5000')
expect('link row: submitted', hw1?.submitted === true && hw1.name === 'Homework 1')
const q0 = a.find((x) => x.id === '4999')
expect('graded row counts as submitted', q0?.submitted === true)

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
