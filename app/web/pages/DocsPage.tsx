import type { ReactNode } from 'react';
import { Toc } from '@/components/Toc';
import { GITHUB_URL } from '@/components/site-chrome';
import { Card, container, PageHeader } from '@/components/ui';
import { L, useLang } from '@/lib/i18n';

function Code({ children }: { children: string }) {
  return <pre className="mt-4 overflow-x-auto rounded-lg bg-fill-4 px-4 py-3.5 font-mono text-[13px] leading-relaxed text-label-1">{children}</pre>;
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-[76px] p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function DocsPage() {
  const { lang } = useLang();
  const sections = [
    { id: 'docs-start', label: L(lang, '在自己机器上跑起来', 'Run it on your machine') },
    { id: 'docs-storage', label: L(lang, '数据存在哪儿', 'Where things are kept') },
    { id: 'docs-cases', label: L(lang, '添加题目', 'Adding cases') },
    { id: 'docs-accounts', label: L(lang, '账号和管理员', 'Accounts and admins') },
    { id: 'docs-open', label: L(lang, '沙箱机，和给别人用之前', 'Runners, and before you let others in') },
    { id: 'docs-cli', label: L(lang, '不用浏览器', 'Without the browser') },
  ];
  const [start, storage, cases, accounts, open, cli] = sections;
  const text = 'mt-2 text-sm leading-7 text-label-2';
  const more = 'mt-3 text-[13px] text-label-3';
  const repo = (path: string, label: string) => <a href={`${GITHUB_URL}/blob/main/${path}`} target="_blank" rel="noreferrer" className="text-link hover:underline">{label}</a>;

  return (
    <div className={container}>
      <PageHeader title={L(lang, '文档', 'Docs')} sub={L(lang, 'FDE Gym 是开源的：题库、训练台和账号系统可以整套跑在你自己的机器上，一条命令启动。', 'FDE Gym is open source: the case library, the workbench and the accounts all run on a machine of your own, started with one command.')} />
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start">
        <Card padded={false} className="min-w-0 divide-y divide-divider">
          <Block id={start.id} title={start.label}>
            <p className={text}>{L(lang, '需要 Docker 和 Python 3.9 以上。客户方的人由一个便宜的大模型扮演，所以还要一个 OpenRouter 密钥，放在仓库之外的文件里。', 'You need Docker and Python 3.9 or later. A cheap model plays the customer’s people, so you also need an OpenRouter key, kept in a file outside the repository.')}</p>
            <Code>{`git clone ${GITHUB_URL}.git && cd fde-gym
mkdir -p ~/.fdegym && echo "sk-or-..." > ~/.fdegym/openrouter_key
python3 scripts/fetch_cases.py        # the three open cases, into cases/
docker compose up --build             # http://127.0.0.1:8787`}</Code>
            <p className={more}>{L(lang, '这会启动网站、一台沙箱机、PostgreSQL 和一个 S3 协议的对象存储。第一个注册的账号自动成为管理员。', 'This starts the site, a runner, PostgreSQL and an S3-compatible object store. The first account to sign up becomes the admin.')}</p>
          </Block>

          <Block id={storage.id} title={storage.label}>
            <p className={text}>{L(lang, '账号、练习记录和题库里每道题的信息在 PostgreSQL 里。题目的文件在对象存储里，每个版本一个包；网站运行一道题时把它取到本机。对象存储走 S3 协议，阿里云 OSS、腾讯云 COS、Cloudflare R2、AWS S3 都能接。', 'Accounts, runs and the library’s listings are in PostgreSQL. The cases’ files are in object storage, one archive per version; the site fetches a case to its own disk when it runs one. The store is reached over the S3 protocol, so Alibaba Cloud OSS, Tencent COS, Cloudflare R2 and AWS S3 all work.')}</p>
            <Code>{`FDEGYM_DATABASE_URL=postgres://user:password@host:5432/fdegym
FDEGYM_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
FDEGYM_S3_REGION=oss-cn-hangzhou
FDEGYM_S3_BUCKET=my-fdegym
FDEGYM_S3_ACCESS_KEY_ID=...  FDEGYM_S3_SECRET_ACCESS_KEY=...
FDEGYM_S3_FORCE_PATH_STYLE=0`}</Code>
          </Block>

          <Block id={cases.id} title={cases.label}>
            <p className={text}>{L(lang, '题目不在这个仓库里。一道题写出来是一个文件夹；导入之后，它的信息进数据库，文件进对象存储。三种导入方式：网站启动时自动导入 cases/ 里的文件夹；管理后台上传 .tar.gz；或者用命令行。三道示例题公开下载，完整的 20 个场景需要申请。', 'The cases are not in this repository. A case is authored as a folder; importing it puts its listing in the database and its files in object storage. Three ways in: the site imports the folders in cases/ when it starts; an admin uploads a .tar.gz in the admin console; or the command line. Three example cases are open to download; the full set of 20 scenarios is available on request.')}</p>
            <Code>{`docker compose run --rm gym npm run cases -- list`}</Code>
            <p className={more}>
              <a href="https://huggingface.co/datasets/DeepLethe/FDE-Gym-examples" target="_blank" rel="noreferrer" className="text-link hover:underline">DeepLethe/FDE-Gym-examples</a>
              {' · '}
              <a href="https://huggingface.co/datasets/DeepLethe/FDE-Gym" target="_blank" rel="noreferrer" className="text-link hover:underline">DeepLethe/FDE-Gym</a>
            </p>
          </Block>

          <Block id={accounts.id} title={accounts.label}>
            <p className={text}>{L(lang, '注册方式在管理后台里选：开放注册、邮箱验证，或者关闭。也可以允许不注册直接练习，记录留在浏览器里，登录后归到账号下。后台还能暂停某道题、设置训练台里 coding agent 用的模型和花费上限、查看每个人的练习。排行榜只列有账号的成员，显示的是账号里填的名字。', 'How people sign up is chosen in the admin console: open, by e-mail confirmation, or closed. Practising without an account can be allowed too; those runs stay in the browser and move to the account on sign-in. The console also pauses a case, sets the model and the spending cap for the workbench’s coding agent, and shows each person’s runs. The leaderboard lists members with an account only, under the name on the account.')}</p>
          </Block>

          <Block id={open.id} title={open.label}>
            <p className={text}>
              {L(lang, '练习的人写的代码在沙箱机上执行，不在网站上。沙箱机不持有数据库、对象存储和模型密钥，每次练习有自己的系统用户。要加机器，在那台机器上用网站地址和加入令牌启动一个沙箱机就行，它主动连回网站，不需要开放端口。给别人用之前：把加入令牌和默认密码换掉，前面加反向代理和 TLS。', 'The code people write is executed on a runner, not on the site. A runner holds no database, object storage or model key, and gives each run a system user of its own. To add a machine, start a runner on it with the site’s address and join token: it connects back to the site and needs no open port. Before others use it: replace the join token and the default passwords, and put a reverse proxy with TLS in front.')}
            </p>
            <Code>{`FDEGYM_SITE_URL=https://gym.example.com FDEGYM_RUNNER_TOKEN=... \\
  docker compose -f docker-compose.runner.yml up --build -d`}</Code>
            <p className={more}>{repo('docs/self-hosting.md', L(lang, '部署和安全说明', 'Deployment and security notes'))}</p>
          </Block>

          <Block id={cli.id} title={cli.label}>
            <p className={text}>{L(lang, '同一道题也可以在命令行里做：生成工作区，启动客户方的人，在工作区目录里干活，最后评分。想看一个 AI agent 独自能走多远，就把它放进这个目录。', 'The same case can be worked from the command line: build the workspace, start the customer’s people, work inside the workspace folder, then grade. To see how far an AI agent gets on its own, put it in that folder.')}</p>
            <Code>{`python3 harness/run.py new   --engagement oncall_incident --level L3 --name oncall-1
python3 harness/run.py serve --name oncall-1
python3 harness/run.py grade --name oncall-1`}</Code>
            <p className={more}>{repo('harness/README.md', 'harness/README.md')}</p>
          </Block>
        </Card>
        <Toc title={L(lang, '本页目录', 'On this page')} items={sections} />
      </div>
    </div>
  );
}
