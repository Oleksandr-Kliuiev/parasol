import { useRef } from 'react';
import { TabList, type TabListProps } from '@fluentui/react-components';
import { useScrollEdges } from '../utils/useScrollEdges';

/** A tab row that scrolls sideways on a narrow screen and fades the edge that hides more tabs. */
export function ScrollTabList({ style, ...props }: TabListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref, 'x', props.selectedValue);
  return <TabList {...props} ref={ref} style={{ ...style, ...edges.style }} />;
}
