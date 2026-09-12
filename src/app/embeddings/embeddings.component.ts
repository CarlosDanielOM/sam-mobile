import { SamThemeScopeDirective, SamPressDirective, SamRevealDirective } from '../../core/ui';
import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, OnDestroy, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { Dialogs, type TextField, type View } from '@nativescript/core';
import type { BenchmarkSize } from '../../core/embeddings/lab';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';
import { EmbeddingsLabService } from './embeddings-lab.service';

@Component({
  selector: 'ns-embeddings', templateUrl: './embeddings.component.html',
  styleUrls: ['./embeddings.component.css'], imports: [NativeScriptCommonModule, DrawerComponent, SamThemeScopeDirective, SamPressDirective, SamRevealDirective],
  schemas: [NO_ERRORS_SCHEMA], changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbeddingsComponent implements OnDestroy {
  readonly lab = inject(EmbeddingsLabService);
  readonly drawer = inject(DrawerService);
  readonly wide = signal(false);
  readonly sizes: { value: BenchmarkSize; title: string }[] = [
    { value: 'short', title: 'Short' }, { value: '128', title: '~128 tokens' },
    { value: '256', title: '~256 tokens' }, { value: 'near512', title: 'Near 512 tokens' },
  ];
  private poll: ReturnType<typeof setInterval> | null = null;

  mounted(): void {
    if (this.poll !== null) return;
    this.lab.refresh();
    if (!this.lab.state().busy) this.lab.sample();
    this.poll = setInterval(() => this.lab.refresh(), 500);
  }
  unmounted(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }
  ngOnDestroy(): void { this.unmounted(); }
  layout(event: unknown): void {
    const view = (event as { object?: View }).object;
    if (view) this.wide.set(view.getActualSize().width >= 600);
  }
  text(event: unknown): string { return (event as { object?: TextField }).object?.text ?? ''; }
  batch(fullMatrix: boolean): Promise<void> {
    return this.lab.runBatch(fullMatrix, message => Dialogs.confirm({
      title: 'Confirm batching workload', message,
      okButtonText: 'Run selected workload', cancelButtonText: 'Cancel',
    }));
  }
  async remove(): Promise<void> {
    if (this.lab.locked()) return;
    if (await Dialogs.confirm({ title: 'Remove embeddings model?',
      message: 'The installer will drain and unload the runtime, then delete installed and partial model files. Reports remain in memory.',
      okButtonText: 'Remove model', cancelButtonText: 'Keep model' })) this.lab.install('remove');
  }
  async thousand(): Promise<void> {
    if (!this.lab.ready()) return;
    if (await Dialogs.confirm({ title: 'Run 1000 documents?',
      message: 'This manual stress test can take a long time and heat the device. It uses sequential chunks of 10, samples memory/thermal state between chunks, and stops on low memory or severe thermal status. You can cancel; in-flight native work must drain.',
      okButtonText: 'Run 1000', cancelButtonText: 'Cancel' })) this.lab.benchmark(1000, false, true);
  }
}
