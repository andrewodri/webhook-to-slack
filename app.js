const bodyParser = require('body-parser');
const express = require('express');
const https = require('https');
const argv = require('minimist')(process.argv);
const moment = require('moment');
const slack = require('slack');
const url = require('url');
const util = require('util');

let token = argv.token;

let app = express();
app.use(bodyParser.json())

let rtm = slack.rtm.client();

let template = {
    "text": "<http://example.com|9456a94>",
    "attachments": [
        {
            "color": "good",
            "title": "GitHub tag",
            "title_link": "https://api.slack.com/",
            "text": "Commit <http://example.com|9456a94> in <http://example.com|UI_core> was tagged <http://example.com|test>",
            "ts": 123456789,
            "mrkdwn_in": ["text"]
        },
        {
            "color": "warning",
            "title": "CircleCI build",
            "title_link": "https://api.slack.com/",
            "text": "Build number <http://example.com|1001> has completed",
            "ts": 234567891,
            "mrkdwn_in": ["text"]
        },
        {
            "color": "",
            "title": "Docker Hub image",
            "title_link": "https://api.slack.com/",
            "text": "Image <http://example.com|mogo/ui_core:latest> was pushed to <http://example.com|docker.io/mogo/ui_core>",
            "fields": [
                {
                    "title": "Checksum",
                    "value": "7d9495d03763",
                    "short": false
                }
            ],
            "ts": 345678912,
            "mrkdwn_in": ["text"]
        },
        {
            "color": "",
            "title": "Amazon AWS deploy",
            "title_link": "https://api.slack.com/",
            "text": "Image <http://example.com|mogo/ui_core:latest> was deployed to the <http://example.com|test> environment",
            "fields": [
                {
                    "title": "Environment",
                    "value": "https://qua.mogo.ca/",
                    "short": false
                }
            ],
            "ts": 456789123,
            "mrkdwn_in": ["text"]
        },
        {
            "color": "",
            "title": "Amazon AWS deploy",
            "title_link": "https://api.slack.com/",
            "text": "Image <http://example.com|mogo/ui_core:latest> was deployed to the <http://example.com|test> environment",
            "actions": [
                {
                    "name": "deploy",
                    "style": "primary",
                    "text": "Deploy",
                    "type": "button",
                    "value": "deploy"
                }
            ],
            "mrkdwn_in": ["text"]
        }
    ]
};

let messages = [];

app.post('/github', (req, res) => {
  // https://developer.github.com/v3/activity/events/types/#createevent

  let data = req.body;

  console.log(util.inspect(req.body, { colors: true, depth: null }));

  if(!/refs\/tags\/.+/.test(data.ref)){
    res.json({ status: 'ignored' });
    return;
  }

  let tag = /refs\/tags\/(.+)/.exec(data.ref)[1];
  let githubSender = data.sender.login;
  let githubOwner = data.repository.owner.name;
  let githubRepo = data.repository.name;
  let githubUrl = `${data.repository.url}/tree/${tag}`;
  let commitHash = data.after || data.head_commit.id;

  slack.chat.postMessage(Object.assign({
    token,
    channel: 'G27UFB5JN'
  }, template), (err, postMessage) => {
    messages.push({
      tag,
      githubSender,
      githubOwner,
      githubRepo,
      githubUrl,
      commitHash,
      status: 'github-success',
      ts: postMessage.ts
    });
  });

  res.json({ status: 'ok' });
});

app.get('/circleci', (req, res) => {

  let tag = req.query.tag;
  let commitHash = req.query.sha1;
  let messageIndex = messages.findIndex(element => element.tag == tag && element.commitHash == commitHash);

  console.log(util.inspect(req.query, { colors: true, depth: null }));

  if(messageIndex < 0){
    res.json({ status: 'ignored' });
    return;
  }

  let updates = {
    buildNum: req.query.buildNum,
    circleciUrl: req.query.buildUrl,
    status: 'circleci-progress'
  };

  messages[messageIndex] = Object.assign(messages[messageIndex], updates);
  res.json(messages[messageIndex]);
});

app.post('/circleci', (req, res) => {
  // https://circleci.com/docs/configuration/#notify
  // https://circleci.com/docs/api/#build

  let data = req.body.payload;
  let tag = data.vcs_tag;
  let githubSender = data.user.login;
  let githubOwner = data.username;
  let githubRepo = data.reponame;
  let commitHash = data.vcs_revision;
  let buildNum = data.buildNum;
  let messageIndex = messages.findIndex(element => element.buildNum == buildNum);

  console.log(util.inspect(req.body, { colors: true, depth: null }));

  if(messageIndex < 0){
    res.json({ status: 'ignored' });
    return;
  }

  let dockerStep = data.payload.steps.find(element => element.name == "docker push affirmix/test");
  let dockerPushedAt = moment(dockerStep.end_time);

  let circleRequest = https.request(url.parse(dockerStep.actions[0].output_url), circleResponse => {
    let dataString = '';

    circleResponse.on('data', chunk => dataString += chunk).on('end', () => {
      let data = JSON.parse(dataString);
      let match = /digest:\s+sha256:(\w+)/gm.exec(data[0].message);
      let dockerHash = match[1];

      console.log(dockerHash);
    });
  });

  let updates = {
    dockerPushedAt,
    buildTime: data.build_time_millis,
    buildResult: data.outcome,
    status: data.outcome == 'success' ? 'circleci-success' : 'circleci-failure'
  };

  messages[messageIndex] = Object.assign(messages[messageIndex], updates);
  if(data.outcome !== 'success') messages.splice(messageIndex, 1);
  res.json(messages[messageIndex]);
});

app.post('/dockerhub', (req, res) => {
  // https://docs.docker.com/docker-hub/webhooks/

  let data = req.body;
  let dockerPushedAt = moment.unix(data.push_data.pushed_at);
  let messageIndex = messages.findIndex(element => element.dockerPushedAt.isSame(dockerPushedAt, 'minute'));

  console.log(util.inspect(req.body, { colors: true, depth: null }));

  if(messageIndex < 0){
    res.json({ status: 'ignored' });
    return;
  }

  let updates = {
    dockerhubUrl: data.repository.repo_url,
    status: 'dockerhub-success'
  };

  messages[messageIndex] = Object.assign(messages[messageIndex], updates);
  res.json(messages[messageIndex]);
});

rtm.message(message => {
  console.log(util.inspect(message, { colors: true, depth: null }));

  slack.users.list({token}, (err, usersList) => {
    console.log(util.inspect(usersList, { colors: true, depth: null }));

    let slackUser = message.user;
    let githubUser = usersList.members.find(element => !element.is_bot && element.profile.skype == 'andrewodri');

  });
});

rtm.team_join(teamJoin => {

});

app.listen(3000);
rtm.listen({token});
