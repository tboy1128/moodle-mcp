#!/usr/bin/env node

const https = require('https');
const http = require('http');
const url = require('url');

const MOODLE_URL = process.env.MOODLE_URL || 'https://moodle.lsu.edu';
const MOODLE_TOKEN = process.env.MOODLE_TOKEN || '';
const PORT = process.env.PORT || 3000;

function moodleRequest(wsfunction, params = {}) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({
      wstoken: MOODLE_TOKEN,
      wsfunction,
      moodlewsrestformat: 'json',
      ...params
    });

    const requestUrl = `${MOODLE_URL}/webservice/rest/server.php?${queryParams}`;
    const parsedUrl = url.parse(requestUrl);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    lib.get(requestUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response from Moodle'));
        }
      });
    }).on('error', reject);
  });
}

const tools = [
  {
    name: "get_courses",
    description: "Get all courses the user is enrolled in",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_assignments",
    description: "Get assignments for a specific course",
    inputSchema: {
      type: "object",
      properties: {
        courseids: { type: "string", description: "Course ID (e.g. 12345)" }
      },
      required: ["courseids"]
    }
  },
  {
    name: "get_grades",
    description: "Get grades for a specific course",
    inputSchema: {
      type: "object",
      properties: {
        courseid: { type: "string", description: "Course ID" }
      },
      required: ["courseid"]
    }
  },
  {
    name: "get_upcoming_events",
    description: "Get upcoming calendar events and deadlines",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_site_info",
    description: "Get basic info about the Moodle site and logged in user",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

async function callTool(name, args) {
  switch (name) {
    case "get_site_info": {
      const result = await moodleRequest('core_webservice_get_site_info');
      return `User: ${result.fullname}\nSite: ${result.sitename}\nMoodle version: ${result.release}`;
    }
    case "get_courses": {
      const result = await moodleRequest('core_enrol_get_users_courses', {
        userid: (await moodleRequest('core_webservice_get_site_info')).userid
      });
      if (result.exception) return `Error: ${result.message}`;
      return result.map(c => `ID: ${c.id} | ${c.fullname} (${c.shortname})`).join('\n');
    }
    case "get_assignments": {
      const result = await moodleRequest('mod_assign_get_assignments', {
        'courseids[0]': args.courseids
      });
      if (result.exception) return `Error: ${result.message}`;
      const courses = result.courses || [];
      if (!courses.length) return 'No assignments found.';
      return courses.flatMap(c =>
        c.assignments.map(a =>
          `${a.name} | Due: ${a.duedate ? new Date(a.duedate * 1000).toLocaleString() : 'No due date'} | Course: ${c.fullname}`
        )
      ).join('\n');
    }
    case "get_grades": {
      const result = await moodleRequest('gradereport_user_get_grade_items', {
        courseid: args.courseid,
        userid: (await moodleRequest('core_webservice_get_site_info')).userid
      });
      if (result.exception) return `Error: ${result.message}`;
      const items = result.usergrades?.[0]?.gradeitems || [];
      return items.map(g => `${g.itemname || 'Course total'}: ${g.gradeformatted}`).join('\n') || 'No grades found.';
    }
    case "get_upcoming_events": {
      const now = Math.floor(Date.now() / 1000);
      const result = await moodleRequest('core_calendar_get_action_events_by_timesort', {
        timesortfrom: now,
        limitnum: 20
      });
      if (result.exception) return `Error: ${result.message}`;
      const events = result.events || [];
      if (!events.length) return 'No upcoming events.';
      return events.map(e =>
        `${e.name} | ${new Date(e.timesort * 1000).toLocaleString()} | Course: ${e.course?.fullname || 'N/A'}`
      ).join('\n');
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// MCP over HTTP (SSE transport)
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/sse') {
    // SSE endpoint
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send endpoint event
    res.write(`event: endpoint\ndata: /message\n\n`);

    req.on('close', () => {});
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/message') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const message = JSON.parse(body);
        let response;

        if (message.method === 'initialize') {
          response = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'moodle-mcp', version: '1.0.0' }
            }
          };
        } else if (message.method === 'tools/list') {
          response = {
            jsonrpc: '2.0',
            id: message.id,
            result: { tools }
          };
        } else if (message.method === 'tools/call') {
          const { name, arguments: args } = message.params;
          try {
            const content = await callTool(name, args || {});
            response = {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: content }] }
            };
          } catch (e) {
            response = {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
            };
          }
        } else {
          response = {
            jsonrpc: '2.0',
            id: message.id,
            result: {}
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Moodle MCP Server running');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Moodle MCP server running on port ${PORT}`);
});
