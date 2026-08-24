import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureStateStore } from '../store.js';

describe('FeatureStateStore', () => {
  let tmpDir: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-dev-studio-test-'));
    store = new FeatureStateStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('readState devuelve null para una feature inexistente', async () => {
    const result = await store.readState('feat_nonexistent');
    expect(result).toBeNull();
  });

  it('upsertState crea la feature y persiste en disco', async () => {
    const created = await store.upsertState({
      featureId: 'feat_demo_export-csv',
      title: 'Export reports to CSV',
      status: 'in_progress',
      currentStage: 'Dev',
      stages: {
        PM: { status: 'done', artifact: 'specs.md' },
        Architect: { status: 'done', artifact: 'design.md' },
        Dev: { status: 'in_progress' },
      },
    });

    expect(created.title).toBe('Export reports to CSV');
    expect(created.currentStage).toBe('Dev');
    expect(created.stages.PM?.status).toBe('done');
  });

  it('readState recupera el estado persistido en disco', async () => {
    const created = await store.upsertState({
      featureId: 'feat_demo_export-csv',
      title: 'Export reports to CSV',
      status: 'in_progress',
      currentStage: 'Dev',
      stages: { PM: { status: 'done', artifact: 'specs.md' } },
    });

    const reread = await store.readState('feat_demo_export-csv');
    expect(reread?.stages).toEqual(created.stages);
  });

  it('upsertState fusiona superficialmente sin perder stages previos', async () => {
    await store.upsertState({
      featureId: 'feat_demo_export-csv',
      title: 'Export reports to CSV',
      status: 'in_progress',
      currentStage: 'Dev',
      stages: {
        PM: { status: 'done', artifact: 'specs.md' },
        Architect: { status: 'done', artifact: 'design.md' },
        Dev: { status: 'in_progress' },
      },
    });

    const afterQaFail = await store.upsertState({
      featureId: 'feat_demo_export-csv',
      currentStage: 'QA',
      status: 'blocked',
      stages: { QA: { status: 'failed', notes: '2 tests failing' } },
    });

    expect(afterQaFail.stages.PM?.status).toBe('done');
    expect(afterQaFail.stages.QA?.status).toBe('failed');
    expect(afterQaFail.status).toBe('blocked');
  });

  it('listPending excluye las features con status "done"', async () => {
    await store.upsertState({
      featureId: 'feat_demo_export-csv',
      title: 'Export reports to CSV',
      status: 'blocked',
      currentStage: 'QA',
    });
    await store.upsertState({
      featureId: 'feat_demo_login',
      title: 'Login with OAuth',
      status: 'done',
      currentStage: 'DevOps',
    });

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].featureId).toBe('feat_demo_export-csv');
  });

  it('listFeatures ignora entradas que no son directorios', async () => {
    await store.upsertState({
      featureId: 'feat_demo_export-csv',
      title: 'Export reports to CSV',
      status: 'in_progress',
      currentStage: 'Dev',
    });
    await fs.writeFile(path.join(tmpDir, 'not-a-feature.txt'), 'contenido', 'utf-8');

    const features = await store.listFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].featureId).toBe('feat_demo_export-csv');
  });

  it('readState propaga errores que no son ENOENT (JSON corrupto)', async () => {
    const featureDir = path.join(tmpDir, 'feat_corrupted');
    await fs.mkdir(featureDir, { recursive: true });
    await fs.writeFile(path.join(featureDir, 'state.json'), '{ json invalido', 'utf-8');

    await expect(store.readState('feat_corrupted')).rejects.toThrow();
  });

  it('writeState actualiza updatedAt automáticamente', async () => {
    const before = new Date();
    const created = await store.upsertState({
      featureId: 'feat_timestamp',
      title: 'Timestamp test',
      status: 'pending',
      currentStage: 'PM',
    });
    const after = new Date();

    const updatedAt = new Date(created.updatedAt);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
