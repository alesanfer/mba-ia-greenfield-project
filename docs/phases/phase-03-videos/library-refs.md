---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-03T20:16:35-03:00"
  bullmq:
    version: "^6.5.4"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-03T20:16:35-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-03T20:16:35-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-03T20:16:35-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T20:15:55-03:00"
---

# phase-03-videos — Library References

Docs destiladas das bibliotecas decididas nesta fase. As versões foram conferidas no registry npm em 2026-11-03.

> **Como foram obtidas:** o servidor MCP `context7` não está configurado no `.mcp.json` desta sessão. Usei a **API HTTP pública do Context7**: `GET https://context7.com/api/v1/search?query=…` substitui `resolve-library-id`, e `GET https://context7.com/{id}/{version}/llms.txt?topic=…` substitui `query-docs`. Os IDs e as versões indexadas estão em cada seção. Quando o Context7 não cobria um ponto, ele vem marcado como _fonte oficial fora do Context7_.

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com`, branch `11.0.0`, trust 9.7. Corresponde a `phase-03-videos/TD-01` Decision A e `TD-02` Decision A.
**Installed target:** `@nestjs/bullmq@^12.0.0` — peer `@nestjs/common` / `@nestjs/core` `^10 || ^11 || ^12`, `bullmq ^3 || ^4 || ^5 || ^6` (npm registry). É compatível com o NestJS 11 do projeto.

### Instalação

```bash
npm install --save @nestjs/bullmq bullmq
```

No BullMQ v6 é preciso instalar também o `ioredis` (veja a seção `bullmq` abaixo).

### Conexão global — `forRootAsync` com config namespaced

A conexão é registrada uma única vez. Com o padrão herdado (`registerAs` + `ConfigType`), use `forRootAsync`:

```typescript
BullModule.forRootAsync({
  useFactory: () => ({
    connection: { host: 'localhost', port: 6379 }, // no projeto: host = serviço Compose (ex.: 'redis')
  }),
});
```

Aplicação no projeto: `imports: [ConfigModule]`, `inject: [queueConfig.KEY]` e `useFactory` lendo `REDIS_HOST`/`REDIS_PORT`, no mesmo formato de `TypeOrmModule.forRootAsync` (_Inherited Conventions_).

### Registrar a fila e injetar o producer

```typescript
BullModule.registerQueue({ name: 'audio' }); // nome = token de injeção

@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {} // Queue de 'bullmq'
}
```

`registerQueueAsync` aceita `useFactory` e permite opções por fila, como `defaultJobOptions`, onde podem morar `attempts` e `backoff` de `TD-13`.

### Consumer — `@Processor` + `WorkerHost`

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job<any, any, string>): Promise<any> {
    // chamado quando o worker está ocioso e há jobs; o retorno é gravado no job
    return {};
  }
}
```

- O consumer **precisa estar em `providers`** de um módulo para o `@nestjs/bullmq` registrá-lo.
- Com `TD-02` A, o `@Processor` fica num módulo importado **somente** pelo entrypoint do worker (`WorkerModule`), nunca pelo `AppModule` da API. Senão a API passaria a consumir jobs e rodar FFmpeg (o que contraria `TD-02`).
- `processors: [path]` no `registerQueue` roda o handler num processo forkado **sem DI**. Não use: o worker separado de `TD-02` já isola a carga.

### Worker como aplicação standalone (sem HTTP)

Fonte: `content/application-context.md` (Context7, mesmo ID).

```typescript
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule); // sem listeners de rede
  app.enableShutdownHooks(); // ver nota abaixo
}
bootstrap();
```

`app.close()` dispara os lifecycle hooks e permite que o processo encerre. Como o worker é um processo de longa duração, ele não chama `close()` no fim do bootstrap; o encerramento vem por sinal do container (`docker compose stop`). `enableShutdownHooks()` é API padrão do `INestApplicationContext` (_fonte oficial fora do Context7: docs.nestjs.com → Lifecycle events_).

## bullmq

**Source:** `/taskforcesh/bullmq`, versão indexada `v6.5.3` (a mais próxima da `6.5.4` atual no npm), trust 9.2. Corresponde a `phase-03-videos/TD-01`, `TD-07` e `TD-13`.
**Installed target:** `bullmq@^6.5.4`.

### ⚠️ v6: o cliente Redis é peer dependency opcional

`npm view bullmq@6.5.4` lista `ioredis`, `redis`, `pg` e `bullmq-otel` como `peerDependencies` **opcionais**. O `ioredis` **não** vem mais como dependência direta. O cliente padrão continua sendo o ioredis: a docs v6 descreve `RedisConnection.clientFactory` / `createNodeRedisClient` apenas como forma de *substituir* o ioredis padrão. **Instale `ioredis` explicitamente** (`npm install ioredis`). Sem ele, a conexão falha em runtime.

Se o projeto criar a instância do ioredis em vez de passar `{ host, port }`, ela precisa de `maxRetriesPerRequest: null` para ser usada por Workers:

```typescript
import IORedis from 'ioredis';
const connection = new IORedis({ maxRetriesPerRequest: null });
```

A estratégia de reconexão padrão para ioredis é exponencial, de 1 s a 20 s (`retryStrategy: times => Math.max(Math.min(Math.exp(times), 20000), 1000)`).

### Retentativas com backoff exponencial (`TD-13`)

```typescript
await queue.add('test-retry', { foo: 'bar' }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }, // espera 2^(attempts-1) * delay ms
});
```

As mesmas opções podem ir em `defaultJobOptions` da fila.

### Erro permanente — `UnrecoverableError` (`TD-13`)

```typescript
import { UnrecoverableError } from 'bullmq';
// dentro do processor:
throw new UnrecoverableError('arquivo sem stream de vídeo');
```

Lançar `UnrecoverableError` move o job direto para `failed`, **ignorando `attempts`**. Um `Error` comum consome uma tentativa e reagenda pelo `backoff`.

### Idempotência por vídeo (`TD-07`)

- **`jobId` customizado** (`queue.add(name, data, { jobId: videoId })`): segundo a docs, "if you add a job with an existing id then that job will just be ignored and not added to the queue at all". O mesmo id pode ser reusado depois que o job anterior for removido da fila (manualmente ou via `removeOnComplete`/`removeOnFail`). É a forma indicada em `TD-07` (`jobId` = `videoId`). Restrições: o id **não pode conter `:`** e **não pode ser só dígitos** (`Error: Custom Id cannot be integers`). O UUID do vídeo atende as duas. _Fonte oficial fora do Context7: [docs.bullmq.io → Job Ids](https://docs.bullmq.io/guide/jobs/job-ids). Nos trechos do Context7 só apareceu o mecanismo alternativo de `deduplication`._
- **`deduplication: { id }`** (modo simples): ignora novos `add` com o mesmo id enquanto o original não termina. Emite o evento `deduplicated` em `QueueEvents`.
- Atenção: a docs não diz explicitamente se jobs ainda retidos em `failed`/`completed` bloqueiam um novo `add`; ela só diz que jobs **removidos** liberam o id. Como `TD-13` torna `failed` terminal nesta fase, o plano não depende de re-enfileirar o mesmo vídeo. A política de `removeOnComplete`/`removeOnFail` fica para o implement.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3`, versão indexada `v3.1153.0`, trust 9.6. Corresponde a `phase-03-videos/TD-04`, `TD-05`, `TD-06` e `TD-15`.
**Installed target:** `@aws-sdk/client-s3@^3.1161.0`.

### Cliente único reutilizado

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const client = new S3Client({ region, credentials }); // uma instância por credencial/região, reutilizada
await client.send(new PutObjectCommand({ /* ... */ }));
```

A docs desaconselha instanciar `S3Client` dentro de loops. No projeto, um provider Nest singleton por endpoint segue isso. `TD-04` usa **duas** instâncias: o endpoint interno (`S3_ENDPOINT`), que faz I/O, e o endpoint público (`S3_PUBLIC_ENDPOINT`), que só assina.

### Comandos usados nesta fase

`CreateMultipartUploadCommand`, `UploadPartCommand` (só para assinar), `ListPartsCommand` (retomada), `CompleteMultipartUploadCommand` (recebe `MultipartUpload.Parts[{ ETag, PartNumber }]`), `AbortMultipartUploadCommand` (cancelamento, AMB-4), `HeadObjectCommand` (tamanho real, `TD-08`), `PutObjectCommand` (thumbnail), `GetObjectCommand` (só para assinar). Formato XML do `CompleteMultipartUpload` e do `ListParts` conferido nos trechos do Context7.

### Configuração para storage S3-compatível (MinIO) — _fonte oficial fora do Context7_

- **`endpoint` + `forcePathStyle: true`**: MinIO responde em path-style (`http://host:9000/bucket/key`). `forcePathStyle` é opção do `S3ClientConfig`. Confira no `.d.ts` instalado durante o implement.
- **Checksums padrão (AWS "Data Integrity Protections")**: SDKs lançados a partir de dez/2024 calculam checksum CRC (**CRC32 no SDK JS v3**) em todo upload por padrão. Os parâmetros `requestChecksumCalculation` e `responseChecksumValidation` aceitam `WHEN_SUPPORTED` (**padrão**) e `WHEN_REQUIRED`. Com o padrão, URLs pré-assinadas de `PutObject`/`UploadPart` podem carregar `x-amz-checksum-crc32` / `x-amz-sdk-checksum-algorithm`, e há relatos de `SignatureDoesNotMatch` com storages S3-compatíveis e clientes de navegador. **Para `TD-06`, configure `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'`** nos clientes S3 e cubra isso no teste de integração que faz `PUT` de uma parte via URL assinada. Fonte: [AWS SDKs — Data Integrity Protections for Amazon S3](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html).

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (`packages/s3-request-presigner/README.md`), versão indexada `v3.1153.0`. Corresponde a `phase-03-videos/TD-04`, `TD-06`, `TD-10` e `TD-15`.
**Installed target:** `@aws-sdk/s3-request-presigner@^3.1161.0`. Mantenha a mesma versão do `@aws-sdk/client-s3`.

### `getSignedUrl(client, command, { expiresIn })`

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
```

- **`expiresIn` padrão = 900 s** quando omitido. `TD-06` (partes: 1 h), `TD-10` (stream: 1 h, download: 15 min) e `TD-15` (curta duração) devem passar o valor explicitamente.
- A assinatura é **local, sem I/O**. Por isso o cliente "público" de `TD-04` (`S3_PUBLIC_ENDPOINT`) não precisa alcançar o host em que está configurado.
- **Upload de parte**: `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })`. O cliente faz `PUT` direto no storage e lê o `ETag` do header da resposta. Por isso o CORS do storage precisa expor `ETag` (_research Notes_).
- **Download** (`TD-10`): `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })`. O storage responde com esse `Content-Disposition`.
- `signableHeaders` / `unhoistableHeaders` permitem forçar headers na assinatura. Não são necessários nesta fase.
- `S3RequestPresigner({ ...s3.config })` é a API de baixo nível alternativa. `getSignedUrl` basta.
